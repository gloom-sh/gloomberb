import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables } from "../../../cli/pane-functions/headless";
import { exportNumber, renderReportCsv } from "../../../cli/report-tables";
import { backtestEquityCsv } from "./export";
import { backtestHeadless } from "./headless";
import { backtestReport } from "./report";
import { parseRule } from "./rules";
import { runHistoryBacktest } from "./window";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const day = (index: number) => new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);

function report(equity: boolean) {
  const bars = Array.from({ length: 320 }, (_, index) => {
    const close = 100 + index * 0.37 + Math.sin(index / 7) * 9;
    return { date: day(index), open: close, high: close, low: close, close };
  });
  const window = { end: day(318), includePartial: false };
  const result = runHistoryBacktest({ bars, skippedDates: [], undatedSkipped: 0 }, parseRule("close > sma(50)"), parseRule("close < sma(50)"),
    { lookbackYears: null, costBps: 5, ...window });
  return backtestReport({
    symbol: "CL=F", rules: { entry: "close > sma(50)", exit: "close < sma(50)", label: "Custom rules" },
    costBps: 5, window, unit: "USD", result, equity,
  });
}

test("the pane's CSV is what fn BT --csv --equity prints: the daily curve at full precision, with its units", () => {
  const equity = report(true);
  const freshness = deriveHeadlessFreshness(backtestHeadless, equity, NOW);
  const args = { rawArgument: "CL=F", argument: "CL=F", symbols: ["CL=F"], options: { equity: true } };
  const cli = `${renderReportCsv(headlessReportTables(backtestHeadless, equity, args, "BT", freshness, { complete: true, unavailableSymbols: [] }), freshness)}\n`;
  const pane = backtestEquityCsv(equity, "CL=F", NOW);
  expect(pane).toBe(cli);

  const lines = pane.split("\n");
  expect(lines[0]).toBe("Date,Close (USD),\"Position (1 long, 0 flat)\",Strategy (growth of 1),Buy & hold (growth of 1),Drawdown (%),"
    + "symbol_or_series,currency_or_unit,interval,source,as_of");
  const last = equity.metadata!.result as { equity: Array<{ date: string; strategy: number; drawdownPct: number }> };
  const row = last.equity.at(-1)!;
  expect(row.date).toBe(day(318));
  // Every digit the export keeps, not the four the text view rounds to.
  expect(lines.find((line) => line.startsWith(`${row.date},`))).toContain(`,${exportNumber(row.strategy)},`);
  expect(String(exportNumber(row.strategy)).split(".")[1]!.length).toBeGreaterThan(4);
  expect(lines.find((line) => line.startsWith(`${row.date},`))).toEndWith(`,CL=F,USD,1d,Gloom Cloud,${day(318)}`);
  expect(pane).toContain("# note: CL=F is a rolled front-month continuation");
});

test("summary exports read every metric back at full precision with the run's currency, interval and as-of", () => {
  const summary = report(false);
  const freshness = deriveHeadlessFreshness(backtestHeadless, summary, NOW);
  expect(freshness.asOf).toBe(day(318));
  const args = { rawArgument: "CL=F", argument: "CL=F", symbols: ["CL=F"], options: {} };
  const [metrics] = headlessReportTables(backtestHeadless, summary, args, "BT", freshness, { complete: true, unavailableSymbols: [] }).tables;
  const total = (summary.metadata!.result as { strategy: { totalReturnPct: number } }).strategy.totalReturnPct;
  expect(metrics!.rows[0]).toEqual(["Total return (%)", exportNumber(total), expect.any(Number)]);
  expect(metrics!.identity).toEqual({ currencyOrUnit: "USD", interval: "1d" });
});
