import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
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
  headlessReportTables,
  renderHeadlessPaneText,
  serializeHeadlessPaneResult,
} from "./headless";
import { deriveHeadlessFreshness } from "./freshness";
import { renderReportCsv, selectReportTables } from "../report-tables";
import { setCliWidthOverride } from "../../utils/cli-output";

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

  test("--width wraps the notes, errors and source line under a table, and a column marked whole is never cut", () => {
    const definition: HeadlessPaneDefinition<"rows"> = {
      shape: "rows", argument: { kind: "none" }, options: [],
      freshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data" },
      columns: [{ key: "name", header: "Name" }, { key: "time", header: "Updated", shrink: false }],
      load: () => ({ rows: [] }),
    };
    const result: HeadlessRowsResult = {
      rows: [{ name: "A long index name that will not fit beside the time", time: "2026-10-09 20:15 UTC" }],
      notes: ["A note of more than one line when the terminal is only forty columns wide."],
      errors: ["Three words of error text that also run past forty columns of width"],
    };
    setCliWidthOverride(40);
    try {
      const lines = renderHeadlessPaneText(definition, result, args, "Board").split("\n");
      expect(lines.every((line) => line.length <= 40)).toBe(true);
      expect(lines.find((line) => line.startsWith("A long"))).toMatch(/…\s+2026-10-09 20:15 UTC$/);
      expect(lines.filter((line) => line.startsWith("Notes:") || line.includes("terminal is only"))).toHaveLength(2);
    } finally {
      setCliWidthOverride(null);
    }
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
    expect(text.split("\n").at(-1)).toMatch(/Thu 3 Sep(?: 2026)? 12:00 UTC/);
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
    [{ shape: "rows", argument: { kind: "none" }, options: [], load: () => ({ rows: [{ name: "AAPL", dataSource: "delayed", updatedAt: Date.parse("2026-10-08T19:59:00Z") }] }) }, "delayed"],
    [{ shape: "bundle", argument: { kind: "none" }, options: [], freshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data" },
      load: () => ({ sections: [{ title: "Filings", rows: [{ form: "10-K", asOf: "2026-09-30" }] }] }) }, "not a live feed (filed data)"],
    [{ shape: "series", argument: { kind: "none" }, options: [], load: () => ({ series: [{ id: "x", label: "X", points: [{ date: "2026-10-08", value: 1 }] }] }) }, "status not reported"],
    [{ shape: "snapshot", argument: { kind: "none" }, options: [], load: () => ({ asOf: "2026-10-08T19:59:00Z", items: [{ headline: "Open" }] }) }, "status not reported"],
  ];
  for (const [definition, status] of results) {
    const report = await buildHeadlessFunctionReport({
      headless: definition, token: "TEST", label: "Test", options: {}, instance: {}, capability: { id: "test" },
    } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-freshness") } as MarketContext, "");
    const last = report.text.split("\n").at(-1)!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(last).toStartWith(`Source: ${definition.freshness?.source ?? "Gloom Cloud"} · `);
    expect(last).toMatch(/ · (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2}\b/);
    expect(last).toEndWith(` · ${status}`);
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


test("a report's caveats print as Notes, one per line, apart from the failures under Errors, and JSON carries both", async () => {
  const definition: HeadlessPaneDefinition<"rows"> = {
    shape: "rows", argument: { kind: "none" }, options: [], columns: [{ key: "value", header: "Value" }],
    load: () => ({
      rows: [{ value: 1 }], complete: false,
      notes: ["ETH-USD is excluded from the risk estimate.", "1 holding had no current quote; weighted at the latest completed close."],
      errors: ["Treasury yield: Internal server error"],
    }),
  };
  const report = await buildHeadlessFunctionReport({
    headless: definition, token: "notes", label: "Notes", options: {}, instance: {}, capability: { id: "notes" },
  } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-notes") } as MarketContext, "");
  const lines = report.text.split("\n");
  expect(lines).toContain("Notes:");
  expect(lines).toContain("  ETH-USD is excluded from the risk estimate.");
  expect(lines).toContain("  1 holding had no current quote; weighted at the latest completed close.");
  expect(lines).toContain("Errors: Treasury yield: Internal server error");
  expect(report.data).toMatchObject({
    complete: false, errors: ["Treasury yield: Internal server error"],
    notes: ["ETH-USD is excluded from the risk estimate.", "1 holding had no current quote; weighted at the latest completed close."],
  });
  // Notes alone leave a complete report complete.
  const noted = await buildHeadlessFunctionReport({
    headless: { ...definition, load: () => ({ rows: [{ value: 1 }], notes: ["Matched by date."] }) }, token: "notes", label: "Notes", options: {}, instance: {}, capability: { id: "notes" },
  } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-notes") } as MarketContext, "");
  expect(noted.data.complete).toBe(true);
  expect(noted.text).toContain("Notes: Matched by date.");
  expect(noted.text).not.toContain("Errors");
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
  const csv = renderReportCsv(headlessReportTables(definition, result, args, "Research", deriveHeadlessFreshness(definition, result), { complete: true, unavailableSymbols: [] }));
  expect(csv).toContain("# section: Credit percent\nDate,Value (%)\n2026-09-10,2.7\n");
  expect(csv).toContain("# section: Credit basis points\nDate,Value (bp)\n2026-09-10,270\n");
  expect(renderHeadlessPaneText(definition, { series: [result.series[3]!] }, args, "Unknown")).not.toContain("Unit");
});

async function reportOf(definition: HeadlessPaneDefinition, rawArgument = "") {
  return buildHeadlessFunctionReport({
    headless: definition, token: "TEST", label: "Test report", options: {}, instance: {}, capability: { id: "test" },
  } as ResolvedPaneFunction, { config: createDefaultConfig("/tmp/gloomberb-headless-csv") } as MarketContext, rawArgument);
}

function csvOf(report: Awaited<ReturnType<typeof reportOf>>, section?: string): string[] {
  return serializeCliResult({ data: report.data }, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, {
    text: () => report.text, tables: selectReportTables(report.tables, section),
  }).split("\n");
}

const FILED = { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data" } as const;

describe("fn --csv", () => {
  // The status line names the year only when it is not the current one.
  beforeAll(() => setSystemTime(new Date("2026-10-10T12:00:00Z")));
  afterAll(() => setSystemTime());

  test("a bundle writes each section as its own table with the displayed headers, entries as Metric,Value", async () => {
    const report = await reportOf({
      shape: "bundle", argument: { kind: "none" }, options: [], freshness: FILED,
      columns: [{ key: "shortName", header: "Index" }, { key: "price", header: "Last", align: "right", format: (value) => value == null ? "-" : Number(value).toLocaleString("en-US") }],
      load: () => ({
        sections: [
          { title: "Americas", rows: [{ shortName: "SPX", price: 7812.71, asOf: "2026-10-08" }] },
          { title: "Asia-Pacific", rows: [{ shortName: "KOSPI", price: null, asOf: "2026-10-08" }] },
          { title: "Summary", entries: [{ label: "Breadth", value: 0.615, formatted: "61.5%" }, { label: "Leaders", value: ["SPX", "DAX"] }] },
          { title: "Rates", columns: [{ key: "observedAt", header: "observedAt" }, { key: "detail", header: "Detail" }], rows: [{ observedAt: "2026-10-08", detail: { tenor: "2Y", bid: 4.1 } }] },
        ],
        errors: ["^KS11: No quote provider available for ^KS11"],
        notes: ["Breadth counts constituents above their 50-day average."],
        metadata: { requested: 20, available: 19, notices: ["Showing world indices."] },
      }),
    });
    expect(csvOf(report)).toEqual([
      "# section: Americas",
      "Index,Last",
      "SPX,7812.71",
      "",
      "# section: Asia-Pacific",
      "Index,Last",
      "KOSPI,",
      "",
      "# section: Summary",
      "Metric,Value",
      "Breadth (%),61.5",
      "Leaders,SPX; DAX",
      "",
      "# section: Rates",
      "Observed At,Detail",
      "2026-10-08,\"tenor: 2Y, bid: 4.1\"",
      "",
      "# Source: SEC EDGAR · Thu 8 Oct · not a live feed (filed data)",
      "# incomplete: 19 of 20 available",
      "# error: ^KS11: No quote provider available for ^KS11",
      "# note: Showing world indices.",
      "# note: Breadth counts constituents above their 50-day average.",
    ]);
    // --section writes that one table alone, with the closing lines.
    expect(csvOf(report, "summary").slice(0, 4)).toEqual(["Metric,Value", "Breadth (%),61.5", "Leaders,SPX; DAX", ""]);
    expect(csvOf(report, "2").slice(0, 2)).toEqual(["Index,Last", "KOSPI,"]);
    expect(() => csvOf(report, "Europe")).toThrow("No section \"Europe\". Sections: Americas, Asia-Pacific, Summary, Rates, or a number from 1 to 4.");
  });

  test("a report over several symbols is one table with its symbol column; missing symbols close it", async () => {
    const report = await reportOf({
      shape: "rows", argument: { kind: "tickers" }, options: [], freshness: { ...FILED, observedKey: "date" },
      columns: [
        { key: "symbol", header: "Symbol" },
        { key: "date", header: "Date", format: (value) => String(value).slice(0, 10) },
        { key: "volume", header: "Volume", align: "right", format: (value) => `${(Number(value) / 1e6).toFixed(2)}M` },
      ],
      load: () => ({
        rows: [
          { symbol: "HP", date: "2026-10-01T00:00:00.000Z", volume: 37_614_444 },
          { symbol: "SBK.JO", date: "2026-10-01T00:00:00.000Z", volume: 1_838_873 },
        ],
        unavailableSymbols: ["XYZ"],
      }),
    }, "HP SBK.JO XYZ");
    expect(csvOf(report)).toEqual([
      "Symbol,Date,Volume",
      "HP,2026-10-01,37614444",
      "SBK.JO,2026-10-01,1838873",
      "",
      "# Source: SEC EDGAR · Thu 1 Oct 00:00 UTC · not a live feed (filed data)",
      "# incomplete: no data for XYZ",
    ]);
  });

  test("a series writes every point with its date, one table per series, then its statistics", async () => {
    const report = await reportOf({
      shape: "series", argument: { kind: "none" }, options: [], freshness: FILED,
      load: () => ({
        series: [
          { id: "aapl", label: "AAPL", unit: "USD", points: [{ date: "2026-10-07", open: 1, high: 2.5, low: 0.5, close: 2, volume: 900 }, { date: "2026-10-08", open: 2, high: 3, low: 1.5, close: 2.5, volume: 1000 }] },
          { id: "ratio", label: "Ratio", points: [{ date: Date.parse("2026-10-08T14:30:00Z"), value: 0.1 + 0.2 }] },
        ],
        stats: { correlation: 0.8123 },
      }),
    });
    expect(csvOf(report).slice(0, 13)).toEqual([
      "# section: AAPL",
      "Date,Open (USD),High (USD),Low (USD),Close (USD),Volume",
      "2026-10-07,1,2.5,0.5,2,900",
      "2026-10-08,2,3,1.5,2.5,1000",
      "",
      "# section: Ratio",
      "Time,Value",
      "2026-10-08T14:30:00Z,0.3",
      "",
      "# section: Statistics",
      "Metric,Value",
      "correlation,0.8123",
      "",
    ]);
  });

  test("a snapshot writes its items under the declared columns", async () => {
    const report = await reportOf({
      shape: "snapshot", argument: { kind: "none" }, options: [], freshness: FILED,
      columns: [{ key: "headline", header: "Headline" }, { key: "tickers", header: "Tickers" }],
      load: () => ({ asOf: "2026-10-08T19:59:00Z", items: [{ headline: "Markets open, \"calm\"", tickers: ["SPY", "QQQ"] }] }),
    });
    expect(csvOf(report)).toEqual([
      "Headline,Tickers",
      "\"Markets open, \"\"calm\"\"\",SPY; QQQ",
      "",
      "# Source: SEC EDGAR · Thu 8 Oct 19:59 UTC · not a live feed (filed data)",
    ]);
  });

  test("--json stays the full envelope", async () => {
    const report = await reportOf({
      shape: "rows", argument: { kind: "none" }, options: [], columns: [{ key: "name", header: "Name" }],
      load: () => ({ rows: [{ name: "CPI", detail: { value: 2.45 } }] }),
    });
    const json = { ...DEFAULT_CLI_OPTIONS, format: "json" as const };
    const withTables = serializeCliResult({ data: report.data }, json, { text: () => report.text, tables: report.tables });
    expect(withTables).toBe(serializeCliResult({ data: report.data }, json, { text: () => report.text }));
    expect(Object.keys(JSON.parse(withTables).data)).toEqual([
      "kind", "target", "capabilityId", "symbols", "options", "rowCount", "empty", "complete", "unavailableSymbols", "columns", "rows", "freshness",
    ]);
  });
});
