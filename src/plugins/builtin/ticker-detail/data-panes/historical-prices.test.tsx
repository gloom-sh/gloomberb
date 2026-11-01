import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { exportPaneTable } from "../../../../state/pane-table-export-registry";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneFrame } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import type { PricePoint, Quote } from "../../../../types/financials";
import { HistoricalPricesPane } from "./historical-prices";

const tui = createOpenTuiTestHarness();
const PANE_ID = "history:bars";

afterEach(() => setSystemTime());

/** Mounts HP over `points` and returns the ranges the pane asked the provider for. */
async function mountHistory(points: PricePoint[], savedRange?: string, quote?: Quote) {
  const requested: string[] = [];
  const provider = createTestDataProvider({
    getPriceHistory: async (_symbol, _exchange, range) => {
      requested.push(range);
      return points;
    },
  });
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-history-bars-unused", {
    instanceId: PANE_ID, paneId: "historical-prices", binding: { kind: "fixed", symbol: "AAPL" },
  }));
  state.tickers.set("AAPL", createTestTicker("AAPL"));
  if (quote) state.financials.set("AAPL", createTestFinancials({ quote }));
  if (savedRange) state.paneState[PANE_ID] = { pluginState: { "ticker-research": { range: savedRange } } };
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  await act(async () => {
    await tui.render(
      <TestPaneFrame state={state} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime} width={120} height={14}>
        {(body) => <HistoricalPricesPane paneId={PANE_ID} paneType="historical-prices" focused width={body.width} height={body.height} />}
      </TestPaneFrame>,
      { width: 120, height: 14 },
    );
  });
  await settleFrame(tui.setup(), 8);
  await exportPaneTable(PANE_ID, "history.csv");
  return { requested, frame: tui.frame(), csv: takeSavedTextFile()!.text };
}

const bars = (dates: string[]) => dates.map((date, index) => ({ date: new Date(date), close: 100 + index }));

test("a fresh pane opens on 3M daily bars, and a range saved in the pane stays", async () => {
  const daily = bars(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]);
  const fresh = await mountHistory(daily);
  expect(fresh.requested).toEqual(["3M"]);
  expect(fresh.frame).toContain("daily bars");
  expect(fresh.csv).toContain("Bar size,daily");

  const monthly = bars(["2026-08-01", "2026-09-01"]);
  const saved = await mountHistory(monthly, "ALL");
  expect(saved.requested).toEqual(["ALL"]);
  expect(saved.frame).toContain("monthly bars");
  expect(saved.frame).toContain("MONTH");
  expect(saved.frame).toContain("2026-09");
  expect(saved.frame).not.toContain("2026-09-01");
});

test("a month still running is month to date in the table, footer and export, not a bar dated on its first day", async () => {
  // Fri 16 Oct 2026 08:14 UTC: New York has not opened; Thursday's session is the latest close.
  setSystemTime(new Date("2026-10-16T08:14:00Z"));
  const { frame, csv } = await mountHistory(bars(["2026-08-01", "2026-09-01", "2026-10-01"]), "ALL");
  expect(frame).toContain("monthly bars");
  expect(frame).toContain("2026-10 MTD");
  expect(frame).toContain("2026-09");
  expect(frame).not.toContain("2026-10-01");
  expect(frame).toContain("month to date, through Thu 15 Oct 2026");
  // The export keeps each bar's own date and says which bar is partial.
  expect(csv).toContain("2026-10-01");
  expect(csv).not.toContain("MTD");
  expect(csv).toContain("Bar size,monthly");
  expect(csv).toContain('Partial bar,"2026-10-01, month to date, through Thu 15 Oct 2026"');
});

test("a week still running is week to date, and a finished week is not", async () => {
  const weeks = bars(["2026-10-05", "2026-10-12"]);
  // Thu 15 Oct 2026: the week of the 12th is under way.
  setSystemTime(new Date("2026-10-15T15:00:00Z"));
  const running = await mountHistory(weeks, "5Y");
  expect(running.frame).toContain("weekly bars");
  expect(running.frame).toContain("WEEK OF");
  expect(running.frame).toContain("2026-10-12 WTD");
  expect(running.frame).toContain("week to date");
  // Tue 20 Oct 2026: that week is over.
  setSystemTime(new Date("2026-10-20T15:00:00Z"));
  const finished = await mountHistory(weeks, "5Y");
  expect(finished.frame).toContain("2026-10-12");
  expect(finished.frame).not.toContain("WTD");
  expect(finished.frame).not.toContain("to date");
});

// Fri 16 Oct 2026, 15:14 in New York: the session is open.
const SESSION_NOW = new Date("2026-10-16T19:14:30Z");

function sessionQuote(overrides: Partial<Quote> = {}): Quote {
  return createTestQuote({
    symbol: "AAPL", price: 341.57, previousClose: 342, open: 346.085, high: 347.82, low: 340.46, volume: 39_269_651,
    lastUpdated: SESSION_NOW.getTime() - 15 * 60_000, marketState: "REGULAR", changeSessionDate: "2026-10-16",
    listingExchangeName: "NASDAQ", instrumentType: "Common Stock", ...overrides,
  });
}

/** What the source served at 19:13Z: today's bar a snapshot of the first minutes of the session. */
const snapshot: PricePoint[] = [
  { date: new Date("2026-10-14"), open: 344.61, high: 347.09, low: 341.72, close: 342.96, volume: 50_061_100 },
  { date: new Date("2026-10-15"), open: 346.95, high: 347.85, low: 341.6, close: 342, volume: 39_678_300 },
  { date: new Date("2026-10-16"), open: 346.085, high: 347.8, low: 341.12, close: 341.995, volume: 1_096_219 },
];

test("today's bar while the session trades is the quote's, marked as today so far in the table, footer and export", async () => {
  setSystemTime(SESSION_NOW);
  const { frame, csv } = await mountHistory(snapshot, undefined, sessionQuote());
  // The snapshot's close and 1.1M shares are replaced by the quote's price, day range and volume.
  expect(frame).toContain("2026-10-16 DTD");
  expect(frame).toContain("341.57");
  expect(frame).toContain("340.46");
  expect(frame).toContain("39.27M");
  expect(frame).not.toContain("341.995");
  expect(frame).not.toContain("1.10M");
  expect(frame).toContain("today so far");
  expect(csv).toContain("2026-10-16,346.08,347.82,340.46,341.57,-0.43");
  expect(csv).not.toContain("DTD");
  expect(csv).toContain('Partial bar,"2026-10-16, today so far"');
});

test("with no current quote the session's snapshot is left out, and a closed session keeps its bar", async () => {
  setSystemTime(SESSION_NOW);
  const noQuote = await mountHistory(snapshot, undefined, sessionQuote({ stale: true }));
  expect(noQuote.frame).toContain("2026-10-15");
  expect(noQuote.frame).not.toContain("2026-10-16");
  expect(noQuote.frame).not.toContain("today so far");
  // Sat 17 Oct: Friday's bar is final.
  setSystemTime(new Date("2026-10-17T15:00:00Z"));
  const closed = await mountHistory(snapshot, undefined, sessionQuote({ marketState: "CLOSED", lastUpdated: Date.parse("2026-10-16T20:00:00Z") }));
  expect(closed.frame).toContain("2026-10-16");
  expect(closed.frame).toContain("1.1M");
  expect(closed.frame).not.toContain("DTD");
  // Its move from Thursday, a half cent down, reads 0.00: unsigned, as every other change that rounds to nothing.
  expect(closed.frame).not.toContain("-0.00");
});

test("a move that rounds to nothing reads 0.00, never -0.00", async () => {
  // 100.004 after 100.00 is a move of a thousandth of a percent: below the cent the table shows.
  const { frame } = await mountHistory([
    { date: new Date("2026-10-14"), open: 100, high: 101, low: 99, close: 100 },
    { date: new Date("2026-10-15"), open: 100, high: 101, low: 99, close: 99.996 },
  ]);
  expect(frame).not.toContain("-0.00");
  expect(frame).toContain("0.00");
});

test("a London share under £10 reads to a tenth of a penny with its close in pence, in the table and its export", async () => {
  setSystemTime(new Date("2026-10-27T02:00:00Z"));
  // BP.L as the cloud serves it: float32 pence, divided into pounds.
  const quote = createTestQuote({ symbol: "AAPL", currency: "GBP", providerPriceDivisor: 100, instrumentType: "EQUITY", price: 6.308 });
  const { frame, csv } = await mountHistory([
    { date: new Date("2026-10-22"), open: 6.23, high: 6.2610002, low: 6.1190002, close: 6.1190002 },
    { date: new Date("2026-10-23"), open: 6.2359998, high: 6.3853802, low: 6.192, close: 6.3850002 },
  ], "1M", quote);
  expect(frame).toContain("6.385 638.5p");
  expect(frame).toContain("6.236");
  expect(csv).toContain("2026-10-23,6.236,6.385,6.192,6.385,");
  expect(csv).not.toContain("638.5p");
});

test("a coin's hourly bars ending with the latest trade have no missing-volume warning in the footer or export", async () => {
  setSystemTime(new Date("2026-10-18T16:00:00Z"));
  const bar = (date: string, volume?: number) => ({ date: new Date(date), open: 81_000, high: 81_100, low: 80_900, close: 81_050, volume });
  const latest = bar("2026-10-18T15:57:53Z");
  const signedIn = await mountHistory([bar("2026-10-18T13:00:00Z", 61_200_000), bar("2026-10-18T14:00:00Z", 73_800_000),
    bar("2026-10-18T15:00:00Z", 24_100_000), latest], "1W");
  // Before: "1 of 4 bars has no reported volume (\u2014)" under every signed-in coin history.
  // The footer's warning marker, which opens the note, is gone with it.
  expect(signedIn.frame).not.toContain("[!]");
  expect(signedIn.csv).not.toContain("Volume note");
  const hole = await mountHistory([bar("2026-10-18T13:00:00Z", 61_200_000), bar("2026-10-18T14:00:00Z"),
    bar("2026-10-18T15:00:00Z", 24_100_000), latest], "1W");
  expect(hole.frame).toContain("[!]");
  expect(hole.csv).toContain("Volume note,1 of 4 bars has no reported volume");
});

test("ALL says where the source's bars start, names a month without a bar, and marks the change across it with its base", async () => {
  setSystemTime(new Date("2026-10-21T12:00:00Z"));
  // BTC-USD's monthly bars start 2014-09; November is missing, so December's change is from October.
  const { frame, csv } = await mountHistory(bars(["2014-09-01", "2014-10-01", "2014-12-01"]), "ALL");
  expect(frame).toContain("monthly bars from 2014-09");
  expect(frame).toContain(" 1.00*");
  expect(frame).toContain("+0.99%*");
  expect(frame).toContain("[!]");
  expect(csv).toContain("Source starts,2014-09");
  expect(csv).toContain("Gap note,No bar for 2014-11");
  expect(csv).toContain("Gap note,CHG marked * spans the missing bars: 2014-12 is from 2014-10");
  // The export keeps the change itself, as a number.
  expect(csv).toContain("2014-12-01,,,,102,1,0.99009900990099,");
});

/** `fn HP NG=F` read 2026-10-26's change from November's 2.640 to December's 3.050: two contracts' prices, no move. */
test("a continuous future's bar on a new contract has no change, in the table and its export, and the notice names the roll", async () => {
  setSystemTime(new Date("2026-10-31T12:00:00Z"));
  const rows: Array<[string, number, string]> = [
    ["2026-10-21", 2.79, "NGX26"], ["2026-10-22", 2.80, "NGX26"], ["2026-10-23", 2.64, "NGX26"],
    ["2026-10-26", 3.05, "NGZ26"], ["2026-10-27", 3.00, "NGZ26"],
  ];
  const { frame, csv } = await mountHistory(rows.map(([date, close, contract]) => ({ date: new Date(`${date}T00:00:00Z`), close, contract })));
  expect(frame).toContain("[!]");
  expect(csv).toContain("Gap note,No CHG at the roll to a new contract: 2026-10-26 (NGZ26)");
  const csvRow = (date: string) => csv.split("\n").find((line) => line.startsWith(date))!.split(",");
  // The roll's change cells are blank; the bar after it moves from the new contract's close.
  expect(csvRow("2026-10-26").slice(4, 7)).toEqual(["3.05", "", ""]);
  expect(Number(csvRow("2026-10-27")[5])).toBeCloseTo(-0.05, 10);
  expect(Number(csvRow("2026-10-23")[5])).toBeCloseTo(-0.16, 10);
  const frameRow = frame.split("\n").find((line) => line.includes("2026-10-26"))!;
  expect(frameRow).not.toMatch(/[+-]\d+\.\d+%/);
});
