import { describe, expect, test } from "bun:test";
import {
  exportEntriesTable,
  exportRowsTable,
  exportTextTable,
  renderReportCsv,
  renderReportNdjson,
  reportFooterLines,
  selectReportTables,
  type CliReportTables,
} from "./report-tables";
import type { ReportFreshness } from "./pane-functions/freshness";

const percent = (value: unknown) => value == null ? "-" : `${(Number(value) * 100).toFixed(2)}%`;

describe("report tables", () => {
  test("exports the number behind what the text drew, with its unit in the header", () => {
    const table = exportRowsTable("Board", [
      { key: "name", header: "Name" },
      { key: "price", header: "Last", align: "right", format: (value) => Number(value).toLocaleString("en-US", { minimumFractionDigits: 2 }) },
      { key: "change", header: "Change", align: "right", format: (value) => `+${Number(value).toFixed(2)}` },
      { key: "yield", header: "Yield", align: "right", format: percent },
      { key: "cap", header: "Market cap", align: "right", format: (value) => `$${(Number(value) / 1e9).toFixed(2)}B` },
      { key: "updatedAt", header: "Updated", format: (value) => value == null ? "-" : "2026-10-09 18:25 UTC" },
    ], [
      { name: "S&P 500", price: 7812.71, change: 47.350000000000364, yield: 0.0615, cap: 1_203_456_789, updatedAt: Date.UTC(2026, 9, 9, 18, 25) },
      { name: "Nikkei", price: 69030.92, change: 0.1, yield: null, cap: 999_000_000, updatedAt: null },
    ]);
    expect(table.columns).toEqual(["Name", "Last", "Change", "Yield (%)", "Market cap ($)", "Updated"]);
    expect(table.rows).toEqual([
      // Full precision, not the rounded text, and float noise dropped.
      ["S&P 500", 7812.71, 47.35, 6.15, 1_203_456_789, "2026-10-09T18:25:00Z"],
      ["Nikkei", 69030.92, 0.1, "", 999_000_000, ""],
    ]);
  });

  test("reads figures a statement draws in the unit its header names, past the change beside them", () => {
    const table = exportRowsTable("Income", [
      { key: "metric", header: "Metric" },
      { key: "2025", header: "2025 USD bn", align: "right", format: (_value, row) => String(row.text) },
    ], [
      { metric: "Revenue", 2025: 416_161_000_000, text: "416.2 +6.4%" },
      { metric: "Net income", 2025: 112_010_000_000, text: "112.0 +19%" },
    ]);
    expect(table.rows).toEqual([["Revenue", 416.161], ["Net income", 112.01]]);
  });

  test("a table of metrics names each row's unit in its label; a column of mixed units gets a unit column", () => {
    const metrics = exportRowsTable("Backtest", [
      { key: "metric", header: "Metric" },
      { key: "strategy", header: "Strategy" },
      { key: "hold", header: "Buy & hold" },
    ], [
      { metric: "Total return", strategy: "+398.1%", hold: "+1,056.3%" },
      { metric: "Sharpe", strategy: "0.76", hold: "0.99" },
      { metric: "Hit rate", strategy: "60.0%", hold: "" },
    ]);
    expect(metrics.columns).toEqual(["Metric", "Strategy", "Buy & hold"]);
    expect(metrics.rows).toEqual([["Total return (%)", 398.1, 1056.3], ["Sharpe", 0.76, 0.99], ["Hit rate (%)", 60, ""]]);

    const auctions = exportRowsTable("Auctions", [
      { key: "date", header: "Date" },
      { key: "rate", header: "Rate", align: "right" },
    ], [{ date: "2026-10-08", rate: "5.618%" }, { date: "2026-09-23", rate: "4.0bp" }]);
    expect(auctions.columns).toEqual(["Date", "Rate", "Rate unit"]);
    expect(auctions.rows).toEqual([["2026-10-08", 5.618, "%"], ["2026-09-23", 4, "bp"]]);
  });

  test("keeps codes, tenors, ranges and words as text, a range without the unit its header names", () => {
    const table = exportRowsTable("Curve", [
      { key: "tenor", header: "Tenor" },
      { key: "code", header: "Code" },
      { key: "symbol", header: "Symbol" },
      { key: "rate", header: "Rate", align: "right" },
    ], [
      { tenor: "3M", code: "000001", symbol: "7203", rate: "3.75-4.00%" },
      { tenor: "1Y", code: "0700", symbol: "9988", rate: "2.50%" },
      { tenor: "6M", code: "12345", symbol: "AAPL", rate: "N/M" },
    ]);
    expect(table.rows).toEqual([
      ["3M", "000001", "7203", "3.75-4.00"],
      ["1Y", "0700", "9988", 2.5],
      ["6M", "12345", "AAPL", "N/M"],
    ]);
    expect(table.columns).toEqual(["Tenor", "Code", "Symbol", "Rate (%)"]);
  });

  test("never writes a JSON blob: nested values, JSON strings and JSON a format returns flatten to text", () => {
    const table = exportRowsTable("Nested", [
      { key: "coverage", header: "Coverage" },
      { key: "tags", header: "Tags" },
      { key: "raw", header: "Raw" },
      { key: "formatted", header: "Formatted", format: (value) => JSON.stringify(value) },
      { key: "empty", header: "Empty" },
    ], [{
      coverage: { revenueRows: 10, graphComplete: true, missing: null },
      tags: ["ai", "chips", { region: "US" }],
      raw: "{\"a\":1,\"b\":[2,3]}",
      formatted: { nested: { deep: 1 } },
      empty: [],
    }]);
    expect(table.rows).toEqual([[
      "revenueRows: 10, graphComplete: true",
      "ai; chips; region: US",
      "a: 1, b: 2, 3",
      "nested: deep: 1",
      "",
    ]]);
    const entries = exportEntriesTable("Stats", [
      { label: "Breakdown", value: { up: 3, down: 2 } },
      { label: "Yield", value: 0.0425, formatted: "4.25%" },
      { label: "Tenor", value: "3M" },
      { label: "EPS", value: 31.43, formatted: "31.43 (ccy?)", unit: "ccy?" },
    ]);
    expect(entries.columns).toEqual(["Metric", "Value"]);
    expect(entries.rows).toEqual([["Breakdown", "up: 3, down: 2"], ["Yield (%)", 4.25], ["Tenor", "3M"], ["EPS (ccy?)", 31.43]]);
  });

  test("a rendered table exports the instant behind a shortened time and numbers from its text", () => {
    const table = exportTextTable("Futures", ["Symbol", "Last", "Time"], [
      [{ text: "ES" }, { text: "7,864.25" }, { text: "Wed 11:27", instant: "2026-10-07T15:27:00.000Z" }],
      [{ text: "ZC" }, { text: "480.50c" }, undefined],
    ]);
    expect(table.columns).toEqual(["Symbol", "Last", "Last unit", "Time"]);
    expect(table.rows).toEqual([["ES", 7864.25, "", "2026-10-07T15:27:00.000Z"], ["ZC", 480.5, "c", ""]]);
  });
});

const freshness: ReportFreshness = {
  source: "Gloom Cloud",
  asOf: "2026-10-09T18:28:00.000Z",
  status: "delayed",
  retrievedAt: "2026-10-09T18:30:00.000Z",
};

function report(): CliReportTables {
  return {
    tables: [
      { title: "Americas", columns: ["Index", "Name", "Last"], rows: [["SPX", "S&P 500, Inc.", 7812.71], ["#1", "Says \"hi\"\nagain", ""]] },
      { title: "Europe", columns: ["Index", "Last"], rows: [["DAX", 25087.27]] },
    ],
    footer: reportFooterLines({
      freshness,
      incomplete: "19 of 20 available",
      errors: ["^KS11: No quote provider available for ^KS11"],
      notes: ["Two bars are\nunavailable."],
    }),
  };
}

describe("report CSV and NDJSON", () => {
  test("stacks several tables under section lines, quotes cells, and ends with the footer", () => {
    expect(renderReportCsv(report()).split("\n")).toEqual([
      "# section: Americas",
      "Index,Name,Last",
      "SPX,\"S&P 500, Inc.\",7812.71",
      // A first cell starting with # is quoted so no reader takes the row for a comment.
      "\"#1\",\"Says \"\"hi\"\"",
      "again\",",
      "",
      "# section: Europe",
      "Index,Last",
      "DAX,25087.27",
      "",
      "# Source: Gloom Cloud · Fri 9 Oct 18:28 UTC · delayed",
      "# incomplete: 19 of 20 available",
      "# error: ^KS11: No quote provider available for ^KS11",
      "# note: Two bars are unavailable.",
    ]);
  });

  test("--section picks one table by title or position, and names the sections it has", () => {
    expect(renderReportCsv(selectReportTables(report(), "EUROPE")).split("\n").slice(0, 3)).toEqual([
      "Index,Last",
      "DAX,25087.27",
      "",
    ]);
    expect(selectReportTables(report(), "1").tables.map((table) => table.title)).toEqual(["Americas"]);
    expect(() => selectReportTables(report(), "Asia")).toThrow(
      "No section \"Asia\". Sections: Americas, Europe, or a number from 1 to 2.",
    );
    expect(() => selectReportTables(report(), "3")).toThrow("No section \"3\"");
    expect(() => selectReportTables(report(), true)).toThrow("--section needs a section title or number.");
    expect(selectReportTables(report(), undefined).tables).toHaveLength(2);
  });

  test("NDJSON writes one object per row, naming the section when there are several", () => {
    expect(renderReportNdjson(report()).split("\n").map((line) => JSON.parse(line))).toEqual([
      { section: "Americas", Index: "SPX", Name: "S&P 500, Inc.", Last: 7812.71 },
      { section: "Americas", Index: "#1", Name: "Says \"hi\"\nagain", Last: null },
      { section: "Europe", Index: "DAX", Last: 25087.27 },
    ]);
    expect(renderReportNdjson(selectReportTables(report(), "Europe"))).toBe("{\"Index\":\"DAX\",\"Last\":25087.27}");
  });
});
