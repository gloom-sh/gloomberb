import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, settleFrame, takeSavedTextFile } from "../../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../../state/app/context";
import { exportPaneTable } from "../../../../state/pane-table-export-registry";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestPaneConfig, createTestTicker, TestPaneFrame } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import type { PricePoint } from "../../../../types/financials";
import { HistoricalPricesPane } from "./historical-prices";

const tui = createOpenTuiTestHarness();
const PANE_ID = "history:bars";

afterEach(() => setSystemTime());

/** Mounts HP over `points` and returns the ranges the pane asked the provider for. */
async function mountHistory(points: PricePoint[], savedRange?: string) {
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
