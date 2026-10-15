import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { PaneInViewProvider } from "../state/app/activity";
import { createTestDataProvider } from "../test-support/data-provider";
import type { PricePoint, Quote, TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "./coordinator";
import { useChartQueries, useFxRatesMap, useQuoteEntries, useTickerFinancialsMap } from "./hooks";
import { instrumentFromTicker, type ChartRequest, type InstrumentRef } from "./request-types";
import { createIdleEntry, type QueryEntry } from "./result-types";
import { buildChartKey, buildQuoteKey } from "./selectors";
import { createTestTicker } from "../test-support/ticker";

const tui = createOpenTuiTestHarness();
let bumpHarness: (() => void) | null = null;
let replaceChartRequests: ((requests: readonly ChartRequest[]) => void) | null = null;
let latestFxRates: Map<string, number> | null = null;
let latestFinancialsMap: Map<string, TickerFinancials> | null = null;
let latestBoard: Map<string, TickerFinancials> | null = null;
let latestQuoteBoard: Map<string, QueryEntry<Quote>> | null = null;

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

function BoardHarness({
  tickers: boardTickers,
  instruments,
}: {
  tickers: TickerRecord[];
  instruments: readonly InstrumentRef[];
}) {
  const [tick, setTick] = useState(0);
  bumpHarness = () => setTick((current) => current + 1);
  latestBoard = useTickerFinancialsMap(boardTickers);
  latestQuoteBoard = useQuoteEntries(instruments);
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

  test("does not force-refresh chart history while the pane is covered", async () => {
    const calls: boolean[] = [];
    const coordinator = {
      subscribe: () => () => {},
      getVersion: () => 1,
      getChartEntry: () => createIdleEntry<PricePoint[]>(),
      loadChart: async (_request: ChartRequest, options?: { forceRefresh?: boolean }) => {
        calls.push(options?.forceRefresh === true);
        return createIdleEntry<PricePoint[]>();
      },
    };
    setSharedMarketDataCoordinator(coordinator as unknown as MarketDataCoordinator);

    await tui.render(
      <PaneInViewProvider value={false}>
        <ChartQueriesHarness
          initialRequests={[makeChartRequest("1D")]}
          debounceMs={0}
          refreshIntervalMs={20}
        />
      </PaneInViewProvider>,
      { width: 20, height: 1 },
    );
    await act(async () => {
      await tui.setup().renderOnce();
      await new Promise((resolve) => setTimeout(resolve, 45));
      await tui.setup().renderOnce();
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls).not.toContain(true);
  });
});

test("one tick on a two-ticker board keeps the other ticker object identical", async () => {
  const boardTickers = [
    createTestTicker("SAP", "SAP", { exchange: "XETRA", currency: "EUR" }),
    createTestTicker("SIE", "Siemens", { exchange: "XETRA", currency: "EUR" }),
  ];
  const instruments = boardTickers.map((ticker) => instrumentFromTicker(ticker, ticker.metadata.ticker)!);
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  let financialReads = 0;
  let quoteReads = 0;
  const versionOf = (key: string) => versions.get(key) ?? 0;
  const quoteEntry = (instrument: InstrumentRef): QueryEntry<Quote> => ({
    phase: "ready",
    data: {
      symbol: instrument.symbol,
      price: instrument.symbol === "SAP" ? 250 : 180,
      currency: "EUR",
      change: 0,
      changePercent: 0,
      lastUpdated: 1,
    },
    lastGoodData: null,
    source: "test",
    fetchedAt: 1,
    staleAt: null,
    error: null,
    attempts: [],
  });
  setSharedMarketDataCoordinator({
    subscribeKeys: (_keys: readonly string[], listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getKeysVersion: (keys: readonly string[]) => keys.reduce((sum, key) => sum + versionOf(key), 0),
    getKeyVersion: versionOf,
    getTickerFinancialsSync: (instrument: InstrumentRef) => {
      financialReads += 1;
      return {
        ...sampleFinancials,
        quote: { ...sampleFinancials.quote!, symbol: instrument.symbol, price: instrument.symbol === "SAP" ? 250 : 180 },
      };
    },
    getQuoteEntry: (instrument: InstrumentRef) => {
      quoteReads += 1;
      return quoteEntry(instrument);
    },
  } as unknown as MarketDataCoordinator);

  await tui.render(
    <BoardHarness tickers={boardTickers} instruments={instruments} />,
    { width: 20, height: 1 },
  );
  const sap = instruments[0]!;
  const sie = instruments[1]!;
  const sieFinancials = latestBoard?.get("SIE");
  const sapFinancials = latestBoard?.get("SAP");
  const sieQuote = latestQuoteBoard?.get(buildQuoteKey(sie));
  const financialReadsAfterPaint = financialReads;
  const quoteReadsAfterPaint = quoteReads;

  await act(async () => {
    versions.set(buildQuoteKey(sap), versionOf(buildQuoteKey(sap)) + 1);
    for (const listener of listeners) listener();
    bumpHarness?.();
    await tui.setup().renderOnce();
  });

  expect(latestBoard?.get("SIE")).toBe(sieFinancials);
  expect(latestBoard?.get("SAP")).not.toBe(sapFinancials);
  expect(latestQuoteBoard?.get(buildQuoteKey(sie))).toBe(sieQuote);
  expect(financialReads).toBe(financialReadsAfterPaint + 1);
  expect(quoteReads).toBe(quoteReadsAfterPaint + 1);
});

test("a fresh loadQuoteEntry does not open a flight", async () => {
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-09-14T18:00:00Z");
  let calls = 0;
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    getQuote: async () => {
      calls += 1;
      return {
        symbol: "AAPL",
        price: 100,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.now(),
      };
    },
  }));
  try {
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };
    const first = await coordinator.loadQuote(instrument);
    const second = await coordinator.loadQuote(instrument);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(second.phase).toBe("ready");
  } finally {
    coordinator.destroy();
    Date.now = realNow;
  }
});
