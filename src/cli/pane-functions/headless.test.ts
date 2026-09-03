import { describe, expect, test } from "bun:test";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { serializeCliResult } from "../result";
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
    expect(text).toContain("NAME");
    expect(text).toContain("2.5%");
    expect(jsonData(definition, result)).toMatchObject({
      ok: true,
      data: {
        columns: [{ key: "name", header: "Name" }, { key: "value", header: "Value" }],
        rows: [{ name: "CPI", value: 2.45 }],
      },
    });
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
    expect(text).toContain("As of: 2026-09-03T12:00:00Z");
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
