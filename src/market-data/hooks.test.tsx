import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "./coordinator";
import { useChartQueries, useFxRatesMap, useTickerFinancialsMap } from "./hooks";
import type { ChartRequest } from "./request-types";
import { createIdleEntry } from "./result-types";
import { createTestTicker } from "../test-support/ticker";

const tui = createOpenTuiTestHarness();
let bumpHarness: (() => void) | null = null;
let replaceChartRequests: ((requests: readonly ChartRequest[]) => void) | null = null;
let latestFxRates: Map<string, number> | null = null;
let latestFinancialsMap: Map<string, TickerFinancials> | null = null;

const readyUsdEntry = {
  phase: "ready" as const,
  data: 1,
  lastGoodData: 1,
  source: "test",
  fetchedAt: 1,
  staleAt: null,
  error: null,
  attempts: [],
};
const readyEurEntry = {
  phase: "ready" as const,
  data: 1.08,
  lastGoodData: 1.08,
  source: "test",
  fetchedAt: 1,
  staleAt: null,
  error: null,
  attempts: [],
};
const sampleFinancials: TickerFinancials = {
  annualStatements: [],
  quarterlyStatements: [],
  priceHistory: [],
  quote: {
    symbol: "SAP",
    price: 250,
    currency: "EUR",
    change: 2,
    changePercent: 0.8,
    lastUpdated: 1,
  },
};
const tickers: TickerRecord[] = [
  createTestTicker("SAP", "SAP", { exchange: "XETRA", currency: "EUR" }),
];

function HooksHarness() {
  const [tick, setTick] = useState(0);
  bumpHarness = () => setTick((current) => current + 1);

  latestFxRates = useFxRatesMap(["USD", "EUR"]);
  latestFinancialsMap = useTickerFinancialsMap(tickers);

  return <text>{String(tick)}</text>;
}

function ChartQueriesHarness({
  initialRequests,
  debounceMs,
  refreshIntervalMs = 0,
}: {
  initialRequests: readonly ChartRequest[];
  debounceMs: number;
  refreshIntervalMs?: number;
}) {
  const [requests, setRequests] = useState<readonly ChartRequest[]>(initialRequests);
  replaceChartRequests = setRequests;
  useChartQueries(requests, { debounceMs, refreshIntervalMs });

  return <text>{String(requests.length)}</text>;
}

function makeChartRequest(bufferRange: ChartRequest["bufferRange"]): ChartRequest {
  return {
    instrument: {
      symbol: "AAPL",
      exchange: "NASDAQ",
    },
    bufferRange,
    granularity: "range",
  };
}

afterEach(() => {
  bumpHarness = null;
  replaceChartRequests = null;
  latestFxRates = null;
  latestFinancialsMap = null;
  setSharedMarketDataCoordinator(null);
});

describe("market-data hooks", () => {
  test("preserve derived map instances across unrelated rerenders", async () => {
    const coordinator = {
      subscribe: () => () => {},
      getVersion: () => 1,
      getFxEntry: (currency: string) => (currency === "EUR" ? readyEurEntry : readyUsdEntry),
      loadFxRate: async () => {},
      getTickerFinancialsSync: () => sampleFinancials,
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    await tui.render(<HooksHarness />, {
      width: 20,
      height: 1,
    });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const initialFxRates = latestFxRates;
    const initialFinancialsMap = latestFinancialsMap;

    await act(async () => {
      bumpHarness?.();
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    expect(latestFxRates).toBe(initialFxRates);
    expect(latestFinancialsMap).toBe(initialFinancialsMap);
  });

  test("debounces chart query batches and cancels superseded schedules", async () => {
    const loadedRanges: string[] = [];
    const idleChartEntry = createIdleEntry<PricePoint[]>();
    const coordinator = {
      subscribe: () => () => {},
      getVersion: () => 1,
      getChartEntry: () => idleChartEntry,
      loadChart: async (request: ChartRequest) => {
        loadedRanges.push(request.bufferRange);
        return idleChartEntry;
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    await tui.render(
      <ChartQueriesHarness initialRequests={[makeChartRequest("1D")]} debounceMs={40} />,
      {
        width: 20,
        height: 1,
      },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    await act(async () => {
      replaceChartRequests?.([makeChartRequest("1W")]);
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      replaceChartRequests?.([makeChartRequest("1M")]);
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await tui.setup().renderOnce();
    });

    expect(loadedRanges).toEqual(["1M"]);
  });

  test("refreshes chart query batches on an active interval", async () => {
    const calls: Array<{ range: string; forceRefresh: boolean }> = [];
    const idleChartEntry = createIdleEntry<PricePoint[]>();
    const coordinator = {
      subscribe: () => () => {},
      getVersion: () => 1,
      getChartEntry: () => idleChartEntry,
      loadChart: async (request: ChartRequest, options?: { forceRefresh?: boolean }) => {
        calls.push({
          range: request.bufferRange,
          forceRefresh: options?.forceRefresh === true,
        });
        return idleChartEntry;
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    await tui.render(
      <ChartQueriesHarness
        initialRequests={[makeChartRequest("1D")]}
        debounceMs={0}
        refreshIntervalMs={20}
      />,
      {
        width: 20,
        height: 1,
      },
    );

    await act(async () => {
      await tui.setup().renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 45));
      await tui.setup().renderOnce();
    });

    expect(calls[0]).toEqual({ range: "1D", forceRefresh: false });
    expect(calls.some((call) => call.forceRefresh)).toBe(true);
  });
});
