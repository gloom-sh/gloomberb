import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPaneConfig, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { ChartSnapshotContext } from "../../../time-series/hooks";
import { parsedPriceHistoryKey, rememberParsedPriceHistory } from "../../../time-series/parsed-history-cache";
import { useChartResolution, type UseChartResolutionResult } from "../../../time-series/use-chart-resolution";
import type { PricePoint } from "../../../types/financials";
import { ChartComposerPane } from "./pane";
import { buildComparisonChartPreset } from "./presets";

const tui = createOpenTuiTestHarness();

const history: PricePoint[] = [
  { date: new Date("2025-01-02"), open: 100, high: 100, low: 100, close: 100, volume: 100 },
  { date: new Date("2025-01-03"), open: 110, high: 110, low: 110, close: 110, volume: 100 },
];

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
    if (predicate()) {
      await act(async () => tui.setup().renderOnce());
      return;
    }
  }
  throw new Error("Comparison did not reach the expected state");
}

for (const outcome of ["success", "disjoint", "empty", "failed"] as const) {
  test(`comparison waits for both histories before showing ${outcome}`, async () => {
    const firstSymbol = `CMPLA${outcome.toUpperCase()}`;
    const secondSymbol = `CMPLB${outcome.toUpperCase()}`;
    const spec = buildComparisonChartPreset([`${firstSymbol}:NASDAQ`, `${secondSymbol}:NASDAQ`]);
    spec.viewport.dateWindow = { start: "2025-01-01", end: "2025-01-10" };
    const secondHistory = outcome === "empty" ? [] : outcome === "disjoint"
      ? history.map((point) => ({ ...point, date: new Date(point.date.getTime() + 4 * 86_400_000) }))
      : history;
    // Reproduce the live range switch: a cached first leg seeds an unusable
    // shared window while the required histories are still in flight.
    rememberParsedPriceHistory(parsedPriceHistoryKey({ symbol: firstSymbol, exchange: "NASDAQ" }, "1Y", "1d"), history);
    let first = Promise.withResolvers<PricePoint[]>();
    let second = Promise.withResolvers<PricePoint[]>();
    const requested = new Set<string>();
    const provider = createTestDataProvider({
      getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
      getPriceHistoryForResolution: async (symbol) => {
        requested.add(symbol);
        return symbol === firstSymbol ? first.promise : second.promise;
      },
    });
    const sources = {
      dataProvider: provider,
      now: new Date("2025-01-10"),
      loadFredSeries: async () => { throw new Error("Unexpected FRED request"); },
    };
    const paneId = `comparison-loading-${outcome}`;
    const state = createInitialState(createTestPaneConfig("/tmp/comparison-loading-unused", {
      instanceId: paneId, paneId: "chart-composer", settings: { chartSpec: spec },
    }));
    const runtime = createTestPluginRuntime({ getMarketData: () => provider });
    let latest: UseChartResolutionResult | undefined;
    function Harness() {
      latest = useChartResolution(spec, sources, { liveRefreshIntervalMs: 0 });
      return <TestPaneProvider state={state} paneId={paneId} pluginId="charts" runtime={runtime}>
        <ChartSnapshotContext value={latest}>
          <ChartComposerPane paneId={paneId} paneType="chart-composer" focused width={120} height={24} />
        </ChartSnapshotContext>
      </TestPaneProvider>;
    }
    await tui.render(<Harness />, { width: 120, height: 24 });
    await waitFor(() => requested.size === 2);
    expect(latest?.loading).toBe(true);
    expect(latest?.priceComparison?.start).toBeNull();
    expect(tui.frame()).toContain("Loading chart data");
    expect(tui.frame()).not.toContain("Comparison unavailable");

    await act(async () => { first.resolve(history); await Bun.sleep(2); });
    expect(latest?.loading).toBe(true);
    expect(tui.frame()).not.toContain("Comparison unavailable");

    await act(async () => {
      if (outcome === "failed") second.reject(new Error("Controlled history failure"));
      else second.resolve(secondHistory);
    });
    await waitFor(() => latest?.loading === false);
    const settled = tui.frame();
    expect(settled).not.toContain("Loading chart data");
    if (outcome === "success") {
      expect(latest?.series.map((series) => series.points.length)).toEqual([2, 2]);
      expect(settled).not.toContain("Comparison unavailable");
    } else {
      expect(latest?.priceComparison?.start).toBeNull();
      if (outcome === "disjoint") expect(settled).toContain("Comparison unavailable");
      else {
        expect(latest?.errors.length).toBeGreaterThan(0);
        expect(settled).toContain("price history is unavailable");
      }
      expect(settled).not.toContain("no observations in the selected date range");
    }

    if (outcome === "disjoint") {
      // Refreshing a settled empty result must not reveal the old per-leg
      // empty warnings when its composite failure notice is deferred.
      first = Promise.withResolvers<PricePoint[]>();
      second = Promise.withResolvers<PricePoint[]>();
      requested.clear();
      await act(async () => latest!.reload());
      await waitFor(() => requested.size === 2);
      expect(latest?.loading).toBe(true);
      const refreshing = tui.frame();
      expect(refreshing).toContain("Loading chart data");
      expect(refreshing).not.toContain("Comparison unavailable");
      expect(refreshing).not.toContain("no observations in the selected date range");
      await act(async () => { first.resolve(history); second.resolve(secondHistory); });
      await waitFor(() => latest?.loading === false);
      expect(tui.frame()).toContain("Comparison unavailable");
    }
  });
}
