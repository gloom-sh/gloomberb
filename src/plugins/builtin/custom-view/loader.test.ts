import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/headless";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import type { PluginRegistry } from "../../registry";
import { overlayViewRow } from "./live-quotes";
import { loadViewSource, trialLoadViewSource } from "./loader";
import { viewCellColumns, viewCellText } from "./table";
import { applyViewProjection, normalizeViewSpec } from "./view-spec";

function registryFor(headless: Omit<HeadlessPaneDefinition, "argument" | "options">): PluginRegistry {
  const template = {
    id: "slow-pane",
    paneId: "slow",
    label: "Slow",
    description: "Slow",
    shortcut: { prefix: "SLOW", argPlaceholder: "", argKind: "text" as const },
    headless: { argument: { kind: "none" as const }, options: [], ...headless },
  };
  return {
    panes: new Map([["slow", { id: "slow", name: "Slow", component: () => null, defaultPosition: "right" as const }]]),
    paneTemplates: new Map([[template.id, template]]),
  } as unknown as PluginRegistry;
}

function registryWith(load: () => Promise<{ rows: Array<Record<string, unknown>>; columns?: Array<{ key: string; header: string }> }>): PluginRegistry {
  return registryFor({ shape: "rows", load });
}

const config = createDefaultConfig("/tmp/gloom-view-loader");
const spec = normalizeViewSpec({ source: { pane: "SLOW" }, projection: {} });
const signal = new AbortController().signal;

test("a source that has not answered in time opens with a note instead of failing", async () => {
  const never = registryWith(() => new Promise(() => {}));
  const warnings = await trialLoadViewSource(spec, config, { registry: never, timeoutMs: 20 });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("had not answered");
});

test("a source that loads no rows says so, and one that fails throws its own error", async () => {
  const empty = registryWith(async () => ({ rows: [] }));
  expect(await trialLoadViewSource(spec, config, { registry: empty })).toEqual(["The source loaded no rows."]);
  const failing = registryWith(async () => { throw new Error("Feed unavailable."); });
  await expect(trialLoadViewSource(spec, config, { registry: failing })).rejects.toThrow("Feed unavailable.");
});

test("with no rows, a key outside the listed columns only warns, since the columns need not list every key", async () => {
  const listed = registryWith(async () => ({ rows: [], columns: [{ key: "title", header: "Market" }, { key: "venue", header: "Venue" }] }));
  const asking = normalizeViewSpec({ source: { pane: "SLOW" }, projection: { columns: ["title", "lastTradePrice"] } });
  expect(await trialLoadViewSource(asking, config, { registry: listed })).toEqual([
    "The source loaded no rows.",
    "With no rows to check, these are not among the Slow columns: column lastTradePrice. Its columns: title (Market), venue.",
  ]);
});

test("a view draws a value as its source formats it, live values too, and sorts by the value", async () => {
  // MOST's columns: the definition's, which a load that keeps them leaves to it.
  const columns: HeadlessPaneColumn[] = [
    { key: "symbol", header: "Symbol" },
    { key: "price", header: "Last", align: "right", format: (value) => `$${Number(value).toFixed(2)}` },
    { key: "volume", header: "Volume", align: "right", format: (value) => value == null ? "—" : formatCompact(Number(value), { fixedDecimals: true }) },
  ];
  const registry = registryFor({ shape: "rows", columns, load: async () => ({ rows: [
    { symbol: "NVDA", price: 181.5, volume: 4_000_000 },
    { symbol: "AAPL", price: 232.1, volume: 123_456_789 },
    { symbol: "XYZ", price: 3, volume: null },
  ] }) });
  const view = normalizeViewSpec({ source: { pane: "SLOW" }, projection: { columns: ["symbol", "price", "volume"], sort: { by: "volume", direction: "desc" } } });
  const loaded = await loadViewSource(view, config, signal, registry);
  const [, price, volume] = viewCellColumns(view, loaded.columns);
  const rows = applyViewProjection(loaded.rows, view.projection);
  // By the figure, not its text: 123.46M before 4.00M, whatever the letters say.
  expect(rows.map((row) => row.symbol)).toEqual(["AAPL", "NVDA", "XYZ"]);
  expect(rows.map((row) => viewCellText(row, volume!))).toEqual(["123.46M", "4.00M", "—"]);
  const ticked = overlayViewRow(rows[1]!, { symbol: "NVDA", price: 182.25, change: 0, changePercent: 0, volume: 4_100_000, currency: "USD", lastUpdated: 1 },
    new Map([["price", "price" as const], ["volume", "volume" as const]]));
  expect([viewCellText(ticked, price!), viewCellText(ticked, volume!)]).toEqual(["$182.25", "4.10M"]);
});

test("a bundle row keeps its own section's format for a key another section formats apart, and an entry its own text", async () => {
  const registry = registryFor({ shape: "bundle", load: async () => ({ sections: [
    { title: "Moves", columns: [{ key: "symbol", header: "Symbol" }, { key: "value", header: "Move", align: "right" as const, format: (value: unknown) => formatPercentRaw(Number(value)) }],
      rows: [{ symbol: "NVDA", value: 1.5 }] },
    { title: "Sizes", columns: [{ key: "symbol", header: "Symbol" }, { key: "value", header: "Size", align: "right" as const, format: (value: unknown) => formatCompact(Number(value)) }],
      rows: [{ symbol: "NVDA", value: 2_500_000 }] },
    { title: "Facts", entries: [{ label: "Float", value: 2_400_000_000, formatted: "2.40B shares" }, { label: "Beta", value: 1.7 }] },
  ] }) });
  const view = normalizeViewSpec({ source: { pane: "SLOW" }, projection: { columns: ["section", "label", "value", { key: "value", label: "Raw", transform: "raw" }] } });
  const loaded = await loadViewSource(view, config, signal, registry);
  expect(loaded.columns.map((column) => column.key)).toEqual(["section", "symbol", "value", "label"]);
  const [, , value, raw] = viewCellColumns(view, loaded.columns);
  expect(loaded.rows.map((row) => viewCellText(row, value!))).toEqual(["+1.50%", "2.5M", "2.40B shares", "1.70"]);
  // The spec's transform is the spec's: the plain figure, whichever section the row is from.
  expect(loaded.rows.map((row) => viewCellText(row, raw!))).toEqual(["1.50", "2500000", "2400000000", "1.70"]);
  // Row keys are the source's only, for the trial load's check and the filters.
  expect(Object.keys(loaded.rows[0]!)).toEqual(["section", "symbol", "value"]);
});

test("a series is one row per date, its points' times as ISO text, at the decimals its report prints", async () => {
  const registry = registryFor({ shape: "series", load: async () => ({ series: [
    { id: "corr", label: "Correlation", textDecimals: 3, points: [{ date: new Date("2026-11-20T00:00:00Z"), value: 0.81234 }, { date: "2026-11-23", value: 0.8 }] },
  ] }) });
  const loaded = await loadViewSource(spec, config, signal, registry);
  expect(loaded.rows).toEqual([{ date: "2026-11-20T00:00:00.000Z", corr: 0.81234 }, { date: "2026-11-23", corr: 0.8 }]);
  const [date, corr] = viewCellColumns(spec, loaded.columns);
  expect(loaded.rows.map((row) => [viewCellText(row, date!), viewCellText(row, corr!)])).toEqual([["2026-11-20", "0.812"], ["2026-11-23", "0.800"]]);
});
