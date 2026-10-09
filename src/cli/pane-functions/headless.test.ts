import { describe, expect, test } from "bun:test";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import type { ResolvedPaneFunction } from "./resolver";
import type {
  HeadlessBundleResult,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
  HeadlessSeriesResult,
  HeadlessSnapshotResult,
  PaneDef,
  PaneTemplateDef,
} from "../../types/plugin";
import { getPaneFunctionCapability, normalizeCapabilityOptions } from "./capabilities";
import {
  buildHeadlessPaneLoadArgs,
  buildHeadlessFunctionReport,
  renderHeadlessPaneText,
  serializeHeadlessPaneResult,
} from "./headless";

const args: HeadlessPaneLoadArgs = {
  rawArgument: "",
  argument: null,
  symbols: [],
  options: {},
};

function jsonData(
  definition: HeadlessPaneDefinition,
  result: HeadlessRowsResult | HeadlessBundleResult | HeadlessSeriesResult | HeadlessSnapshotResult,
): Record<string, unknown> {
  const output = serializeCliResult(
    { data: serializeHeadlessPaneResult(definition, result) },
    { ...DEFAULT_CLI_OPTIONS, format: "json" },
  );
  return JSON.parse(output) as Record<string, unknown>;
}

describe("headless pane printer", () => {
  test("empty reports mark model-resolved inputs unavailable when the argument contains no tickers", async () => {
    const definition: HeadlessPaneDefinition<"series"> = {
      shape: "series", argument: { kind: "none" }, options: [],
      load: () => ({ symbols: ["SPY"], series: [] }),
    };
    const report = await buildHeadlessFunctionReport({
      headless: definition, token: "benchmark", label: "Benchmark", options: {},
      instance: {}, capability: { id: "benchmark" },
    } as ResolvedPaneFunction, {
      config: createDefaultConfig("/tmp/gloomberb-headless-symbols"),
    } as MarketContext, "");
    expect(report.data).toMatchObject({
      symbols: ["SPY"], unavailableSymbols: ["SPY"], empty: true, complete: false,
    });
  });

  test("renders rows as aligned text and preserves raw values in JSON", () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows",
      argument: { kind: "none" },
      options: [],
      columns: [
        { key: "name", header: "Name" },
        {
          key: "value",
          header: "Value",
          align: "right",
          format: (value) => `${Number(value).toFixed(1)}%`,
        },
      ],
      load: () => ({ rows: [] }),
    };
    const result: HeadlessRowsResult = { rows: [{ name: "CPI", value: 2.45 }] };

    const text = renderHeadlessPaneText(definition, result, args, "Statistics");
    expect(text).toContain("Name");
    expect(text).toContain("2.5%");
    expect(jsonData(definition, result)).toMatchObject({
      ok: true,
      data: {
        columns: [{ key: "name", header: "Name" }, { key: "value", header: "Value" }],
        rows: [{ name: "CPI", value: 2.45 }],
      },
    });
  });

  test("report rows keep midnight instants while calendar series dates stay short", () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows", argument: { kind: "none" }, options: [], load: () => ({ rows: [] }),
    };
    const result: HeadlessRowsResult = { rows: [
      { name: "Date", observedAt: new Date("2026-10-09T00:00:00Z") },
      { name: "ISO", observedAt: "2026-10-09T00:00:00Z" },
      { name: "Calendar", observedAt: "2026-10-09" },
    ] };
    const lines = renderHeadlessPaneText(definition, result, args, "Times").split("\n");
    expect(lines.find((line) => line.startsWith("Date"))).toContain("2026-10-09 00:00 UTC");
    expect(lines.find((line) => line.startsWith("ISO"))).toContain("2026-10-09 00:00 UTC");
    expect(lines.find((line) => line.startsWith("Calendar"))?.trim()).toEndWith("2026-10-09");
    const series: HeadlessPaneDefinition<"series"> = {
      shape: "series", argument: { kind: "none" }, options: [], load: () => ({ series: [] }),
    };
    const text = renderHeadlessPaneText(series, { series: [{ id: "daily", label: "Daily", points: [{ date: "2026-10-09", close: 1 }] }] }, args, "Series");
    expect(text.split("\n").find((line) => line.startsWith("Daily"))).not.toContain("UTC");
  });

  test("renders bundle row and entry sections", () => {
    const definition: HeadlessPaneDefinition<"bundle"> = {
      shape: "bundle",
      argument: { kind: "none" },
      options: [],
      load: () => ({ sections: [] }),
    };
    const result: HeadlessBundleResult = {
      sections: [
        {
          title: "Inflation",
          columns: [{ key: "name", header: "Indicator" }],
          rows: [{ name: "CPI" }],
        },
        {
          title: "CPI detail",
          entries: [{ label: "Latest", value: 2.45, formatted: "2.5%" }],
        },
      ],
    };

    const text = renderHeadlessPaneText(definition, result, args, "Statistics");
    expect(text).toContain("Inflation");
    expect(text).toContain("CPI detail");
    expect(text).toContain("2.5%");
    expect(jsonData(definition, result)).toMatchObject({
      ok: true,
      data: {
        sections: [
          { title: "Inflation", rows: [{ name: "CPI" }] },
          { title: "CPI detail", entries: [{ label: "Latest", value: 2.45 }] },
        ],
      },
    });
  });

  test("renders series summaries and structured stats", () => {
    const definition: HeadlessPaneDefinition<"series"> = {
      shape: "series",
      argument: { kind: "ticker" },
      options: [],
      load: () => ({ series: [] }),
    };
    const result: HeadlessSeriesResult = {
      series: [{
        id: "price",
        label: "Price",
        points: [
          { date: "2026-09-01", value: 100 },
          { date: "2026-09-02", value: 102 },
        ],
      }],
      stats: { return: 0.02 },
    };

    const text = renderHeadlessPaneText(definition, result, args, "Price");
    expect(text).toContain("2026-09-02");
    expect(text).toContain("Statistics");
    expect(jsonData(definition, result)).toMatchObject({
      ok: true,
      data: {
        series: [{ id: "price", points: [{ value: 100 }, { value: 102 }] }],
        stats: { return: 0.02 },
      },
    });
  });

  test("renders snapshot time and items", () => {
    const definition: HeadlessPaneDefinition<"snapshot"> = {
      shape: "snapshot",
      argument: { kind: "none" },
      options: [],
      columns: [{ key: "headline", header: "Headline" }],
      load: () => ({ asOf: "", items: [] }),
    };
    const result: HeadlessSnapshotResult = {
      asOf: "2026-09-03T12:00:00Z",
      items: [{ headline: "Markets open" }],
    };

    const text = renderHeadlessPaneText(definition, result, args, "News");
    expect(text.split("\n").at(-1)).toContain("As of 2026-09-03 12:00 UTC");
    expect(text).toContain("Markets open");
    expect(jsonData(definition, result)).toMatchObject({
      ok: true,
      data: {
        asOf: "2026-09-03T12:00:00Z",
        items: [{ headline: "Markets open" }],
      },
    });
  });
});

test("every report shape ends with its source, as-of and status line, and JSON carries the same facts", async () => {
  const results: Array<[HeadlessPaneDefinition, string]> = [
    [{ shape: "rows", argument: { kind: "none" }, options: [], load: () => ({ rows: [{ name: "AAPL", dataSource: "delayed", updatedAt: Date.parse("2026-10-08T19:59:00Z") }] }) }, "Delayed"],
    [{ shape: "bundle", argument: { kind: "none" }, options: [], freshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data" },
      load: () => ({ sections: [{ title: "Filings", rows: [{ form: "10-K", asOf: "2026-09-30" }] }] }) }, "Not a live feed (filed data)"],
    [{ shape: "series", argument: { kind: "none" }, options: [], load: () => ({ series: [{ id: "x", label: "X", points: [{ date: "2026-10-08", value: 1 }] }] }) }, "Status not reported"],
    [{ shape: "snapshot", argument: { kind: "none" }, options: [], load: () => ({ asOf: "2026-10-08T19:59:00Z", items: [{ headline: "Open" }] }) }, "Status not reported"],
  ];
  for (const [definition, status] of results) {
    const report = await buildHeadlessFunctionReport({
      headless: definition, token: "TEST", label: "Test", options: {}, instance: {}, capability: { id: "test" },
    } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-freshness") } as MarketContext, "");
    const last = report.text.split("\n").at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(last).toStartWith(`Source: ${definition.freshness?.source ?? "Gloom Cloud"} | As of 2026-`);
    expect(last).toEndWith(` | ${status}`);
    expect(report.data.freshness).toMatchObject({ source: definition.freshness?.source ?? "Gloom Cloud", asOf: expect.stringMatching(/^2026-/), retrievedAt: expect.any(String) });
  }
});

describe("headless pane arguments and options", () => {
  test("normalizes symbol lists and enforces their declared minimum", () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows",
      argument: { kind: "tickers", placeholder: "tickers", minimum: 2 },
      options: [],
      load: () => ({ rows: [] }),
    };

    expect(buildHeadlessPaneLoadArgs(definition, "CMP", "$aapl, msft, AAPL", {})).toMatchObject({
      argument: ["AAPL", "MSFT"],
      symbols: ["AAPL", "MSFT"],
    });
    expect(buildHeadlessPaneLoadArgs(definition, "CMP", "$aapl msft, AAPL", {})).toMatchObject({
      symbols: ["AAPL", "MSFT"],
    });
    expect(() => buildHeadlessPaneLoadArgs(definition, "CMP", "AAPL", {}))
      .toThrow("CMP requires at least 2 symbols");
  });

  test("derives ready catalog capability and validates enum values", () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows",
      argument: { kind: "none" },
      options: [{
        key: "mode",
        description: "Display mode.",
        type: "enum",
        values: [{ value: "summary" }, { value: "detail" }],
        defaultValue: "summary",
      }],
      load: () => ({ rows: [] }),
    };
    const pane: PaneDef = {
      id: "example",
      name: "Example",
      component: () => null,
      defaultPosition: "right",
      headless: definition,
    };
    const capability = getPaneFunctionCapability(undefined, pane);

    expect(capability).toMatchObject({
      id: "example",
      botSafe: true,
      reportReadiness: "ready",
      outputKind: "rows",
    });
    expect(normalizeCapabilityOptions(capability, {})).toEqual({ mode: "summary" });
    expect(() => normalizeCapabilityOptions(capability, { mode: "wide" }))
      .toThrow('Invalid --mode value "wide". Use one of: summary, detail.');
  });

  test("prefers a template model when one pane exposes multiple contracts", () => {
    const paneModel: HeadlessPaneDefinition<"rows"> = {
      shape: "rows",
      argument: { kind: "none" },
      options: [],
      load: () => ({ rows: [] }),
    };
    const templateModel: HeadlessPaneDefinition<"series"> = {
      shape: "series",
      argument: { kind: "ticker" },
      options: [],
      load: () => ({ series: [] }),
    };
    const pane: PaneDef = {
      id: "chart",
      name: "Chart",
      component: () => null,
      defaultPosition: "right",
      headless: paneModel,
    };
    const template: PaneTemplateDef = {
      id: "price-chart",
      paneId: pane.id,
      label: "Price",
      description: "Price chart.",
      headless: templateModel,
    };

    expect(getPaneFunctionCapability(template, pane)).toMatchObject({
      outputKind: "series",
      tickerCardinality: "one",
      reportReadiness: "ready",
    });
  });
});

test("partial usable reports retain rows without marking their symbol wholly unavailable", async () => {
  const definition: HeadlessPaneDefinition<"rows"> = {
    shape: "rows", argument: { kind: "none" }, options: [],
    load: () => ({ symbols: ["MSFT"], rows: [{ date: "2025-06-30", margin: .46 }], complete: false }),
  };
  const report = await buildHeadlessFunctionReport({
    headless: definition, token: "partial", label: "Partial", options: {}, instance: {}, capability: { id: "partial" },
  } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-partial") } as MarketContext, "");
  expect(report.data).toMatchObject({ rowCount: 1, empty: false, complete: false, unavailableSymbols: [], rows: [{ date: "2025-06-30", margin: .46 }] });
});

test("headless text preserves applicable coverage notices once before the exported rows", () => {
  const text = renderHeadlessPaneText({ shape: "rows", columns: [{ key: "value", header: "Value" }] } as any,
    { rows: [{ value: 96_571_000_000 }], metadata: { notices: ["Historical versions unavailable.", "Historical versions unavailable.", null, ""] } },
    { symbols: ["MSFT"], options: {}, argument: "MSFT", rawArgument: "MSFT" }, "Financial Statements");
  expect(text.match(/Historical versions unavailable\./g)).toHaveLength(1);
  expect(text.indexOf("Historical versions unavailable.")).toBeLessThan(text.indexOf("Value"));
  expect(text).toContain("96571000000");
});


test("series text distinguishes explicit percent, basis-point and index units without scaling exports", () => {
  const definition: HeadlessPaneDefinition<"series"> = { shape: "series", argument: { kind: "none" }, options: [], load: () => ({ series: [] }) };
  const result: HeadlessSeriesResult = { series: [
    { id: "percent", label: "Credit percent", unit: "%", points: [{ date: "2026-09-10", value: 2.7 }] },
    { id: "bp", label: "Credit basis points", unit: "bp", points: [{ date: "2026-09-10", value: 270 }] },
    { id: "index", label: "Indexed value", unit: "index", points: [{ date: "2026-09-10", value: 102.5 }] },
    { id: "missing", label: "Unknown unit", points: [{ date: "2026-09-10", value: 0 }] },
    { id: "empty", label: "Missing value", unit: "%", points: [] },
  ] };
  const text = renderHeadlessPaneText(definition, result, args, "Research");
  expect(text).toContain("Unit");
  expect(text.split("\n").find(line => line.includes("Credit percent"))).toMatch(/2\.70\s+%/);
  expect(text.split("\n").find(line => line.includes("Credit basis points"))).toMatch(/270\s+bp/);
  expect(text.split("\n").find(line => line.includes("Indexed value"))).toMatch(/102\.5\s+index/);
  expect(text.split("\n").find(line => line.includes("Unknown unit"))).toMatch(/0\s+-/);
  expect(text.split("\n").find(line => line.includes("Missing value"))).toMatch(/-\s+%/);
  expect(jsonData(definition, result)).toMatchObject({ data: { series: result.series } });
  const csv = serializeCliResult({ data: serializeHeadlessPaneResult(definition, result) }, { ...DEFAULT_CLI_OPTIONS, format: "csv" });
  expect(csv).toContain('""unit"":""%"",""points"":[{""date"":""2026-09-10"",""value"":2.7}]');
  expect(csv).toContain('""unit"":""bp"",""points"":[{""date"":""2026-09-10"",""value"":270}]');
  expect(renderHeadlessPaneText(definition, { series: [result.series[3]!] }, args, "Unknown")).not.toContain("Unit");
});
