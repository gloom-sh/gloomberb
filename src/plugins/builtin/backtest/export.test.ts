import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables } from "../../../cli/pane-functions/headless";
import { exportNumber, renderReportCsv } from "../../../cli/report-tables";
import type { HeadlessPaneOptionValues } from "../../../types/headless";
import { backtestEquityCsv } from "./export";
import { backtestHeadless } from "./headless";
import { backtestReport } from "./report";
import { parseRule } from "./rules";
import { runHistoryBacktest } from "./window";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const day = (index: number) => new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
// A float32 feed's close as served, 671.3 to six significant digits.
const FLOAT32_CLOSE = 671.29999;

/** 320 sessions, the last still forming, so the run is through day 318 and warns. */
function report(equity: boolean) {
  const bars = Array.from({ length: 320 }, (_, index) => {
    const close = index === 200 ? FLOAT32_CLOSE : 100 + index * 0.37 + Math.sin(index / 7) * 9;
    return { date: day(index), open: close, high: close, low: close, close, ...(index === 319 ? { partial: true as const } : {}) };
  });
  const window = { end: null, includePartial: false };
  const result = runHistoryBacktest({ bars, skippedDates: [], undatedSkipped: 0 }, parseRule("close > sma(50)"), parseRule("close < sma(50)"),
    { lookbackYears: null, costBps: 5, ...window });
  return backtestReport({
    symbol: "CL=F", rules: { entry: "close > sma(50)", exit: "close < sma(50)", label: "Custom rules" },
    costBps: 5, window, unit: "USD", result, equity,
  });
}

function cliCsv(result: ReturnType<typeof report>, options: HeadlessPaneOptionValues) {
  const freshness = deriveHeadlessFreshness(backtestHeadless, result, NOW);
  const args = { rawArgument: "CL=F", argument: "CL=F", symbols: ["CL=F"], options };
  const tables = headlessReportTables(backtestHeadless, result, args, "BT", freshness, { complete: true, unavailableSymbols: [] });
  return { freshness, tables, csv: `${renderReportCsv(tables, freshness)}\n` };
}

test("the pane's CSV is what fn BT --csv --equity prints: the daily curve at full precision, with its units and warnings", () => {
  const equity = report(true);
  const pane = backtestEquityCsv(equity, "CL=F", NOW);
  expect(pane).toBe(cliCsv(equity, { equity: true }).csv);

  const lines = pane.split("\n");
  expect(lines[0]).toBe("Date,Close (USD),\"Position (1 long, 0 flat)\",\"Strategy (growth of 1, price return, distributions not included)\","
    + "\"Buy & hold (growth of 1, price return, distributions not included)\",Drawdown (%),status,"
    + "symbol_or_series,currency_or_unit,interval,source,as_of");
  const last = equity.metadata!.result as { equity: Array<{ date: string; strategy: number; drawdownPct: number }> };
  const row = last.equity.at(-1)!;
  expect(row.date).toBe(day(318));
  // Every digit the export keeps, not the four the text view rounds to.
  expect(lines.find((line) => line.startsWith(`${row.date},`))).toContain(`,${exportNumber(row.strategy)},`);
  expect(String(exportNumber(row.strategy)).split(".")[1]!.length).toBeGreaterThan(4);
  expect(lines.find((line) => line.startsWith(`${row.date},`))).toEndWith(`,CL=F,USD,1d,Gloom Cloud,${day(318)}`);
  // The close as `history` exports it, without the feed's float32 noise.
  expect(lines.find((line) => line.startsWith(`${day(200)},`))).toStartWith(`${day(200)},671.3,`);
  // What stderr warns stays with the saved file, beside the notes.
  expect(lines.filter((line) => line.startsWith("# note: "))).toEqual([
    `# note: ${day(319)} is still forming (partial) and left out: the test runs through ${day(318)}, the last complete session.`,
    "# note: 365 bars/yr",
    expect.stringMatching(/^# note: CL=F is a rolled front-month continuation/),
  ]);
});

test("summary exports read every metric back at full precision, each row in its own unit and only prices in the currency", () => {
  const summary = report(false);
  const { freshness, tables, csv } = cliCsv(summary, {});
  expect(freshness.asOf).toBe(day(318));
  const total = (summary.metadata!.result as { strategy: { totalReturnPct: number } }).strategy.totalReturnPct;
  expect(tables.tables[0]!.rows[0]).toEqual(["Price return (distributions not included) (%)", exportNumber(total), expect.any(Number), ""]);
  const lines = csv.split("\n");
  const unitOf = (label: string) => lines.find((line) => line.startsWith(`${label},`))!.split(",").at(-4);
  expect(["Price return (distributions not included) (%)", "Sharpe (0% cash)", "Profit factor", "Closed trades", "Average hold (sessions)"].map(unitOf))
    .toEqual(["%", "ratio", "ratio", "trades", "sessions"]);
  expect(lines).toContain("Entry,Entry price (USD),Exit,Exit price (USD),Return %,Sessions,status,symbol_or_series,currency_or_unit,interval,source,as_of");
});
