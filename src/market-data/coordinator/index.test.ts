import { describe, expect, it } from "bun:test";
import { MarketDataCoordinator } from "./index";
import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { PricePoint, Quote, TickerFinancials } from "../../types/financials";
import type { NewsArticle } from "../../news/types";
import { createTestDataProvider } from "../../test-support/data-provider";

type CoordinatorTestProviderOverrides = Partial<DataProvider> & {
  getNews?: (query: {
    feed: "ticker";
    ticker: string;
    exchange?: string;
    tickerTier: "primary";
    limit?: number;
  }) => Promise<NewsArticle[]>;
};

function createProvider(overrides: CoordinatorTestProviderOverrides = {}): DataProvider {
  return createTestDataProvider({
    id: "test-provider",
    getTickerFinancials: async () => ({
      quote: {
        symbol: "AAPL",
        price: 100,
        currency: "USD",
        change: 1,
        changePercent: 1,
        lastUpdated: Date.now(),
      },
      fundamentals: { marketCap: 1 } as any,
      profile: { sector: "Tech" },
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
    }),
    getQuote: async () => ({
      symbol: "AAPL",
      price: 100,
      currency: "USD",
      change: 1,
      changePercent: 1,
      lastUpdated: Date.now(),
    } satisfies Quote),
    search: async () => [] satisfies InstrumentSearchResult[],
    ...overrides,
  });
}

describe("MarketDataCoordinator", () => {
  it("builds a ticker snapshot from the centralized stores", async () => {
    const provider = createProvider({
      getTickerFinancials: async () => ({
        quote: {
          symbol: "AAPL",
          providerId: "gloomberb-cloud",
          price: 189.12,
          currency: "USD",
          change: 2.1,
          changePercent: 1.12,
          lastUpdated: 1_700_000_000_000,
        },
        fundamentals: { trailingPE: 28.1 },
        profile: { sector: "Technology", industry: "Consumer Electronics" },
        annualStatements: [{ date: "2024-09-30", totalRevenue: 1 }],
        quarterlyStatements: [{ date: "2024-12-31", totalRevenue: 1 }],
        priceHistory: [],
      } satisfies TickerFinancials),
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    await coordinator.loadSnapshot(instrument);

    expect(coordinator.getQuoteEntry(instrument).data?.price).toBe(189.12);
    expect(coordinator.getTickerFinancialsSync(instrument)?.fundamentals?.trailingPE).toBe(28.1);
    expect(coordinator.getTickerFinancialsSync(instrument)?.profile?.industry).toBe("Consumer Electronics");
  });

  it("keeps last good chart data when a refresh returns empty", async () => {
    const histories: PricePoint[][] = [
      [
        { date: new Date("2024-01-01"), close: 100 },
        { date: new Date("2024-01-02"), close: 101 },
      ],
      [],
    ];
    const provider = createProvider({
      getPriceHistory: async () => histories.shift() ?? [],
    });
    const coordinator = new MarketDataCoordinator(provider);
    const request = {
      instrument: { symbol: "AAPL", exchange: "NASDAQ" },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    };

    const first = await coordinator.loadChart(request);
    expect(first.data?.length).toBe(2);

    const second = await coordinator.loadChart(request, { forceRefresh: true });
    expect(second.data).toBeNull();
    expect(second.lastGoodData?.length).toBe(2);
  });

  it("reuses fresh snapshots instead of refetching on every pane rerender", async () => {
    let calls = 0;
    const provider = createProvider({
      getTickerFinancials: async () => {
        calls += 1;
        return {
          quote: {
            symbol: "AAPL",
            price: 100 + calls,
            currency: "USD",
            change: 1,
            changePercent: 1,
            lastUpdated: Date.now(),
          },
          fundamentals: { marketCap: calls } as any,
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
        } satisfies TickerFinancials;
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    const first = await coordinator.loadSnapshot(instrument);
    const second = await coordinator.loadSnapshot(instrument);
    const refreshed = await coordinator.loadSnapshot(instrument, { forceRefresh: true });

    expect(first.data?.quote?.price).toBe(101);
    expect(second.data?.quote?.price).toBe(101);
    expect(refreshed.data?.quote?.price).toBe(102);
    expect(calls).toBe(2);
  });

  it("serves USD exchange rates without hitting the provider", async () => {
    let calls = 0;
    const provider = createProvider({
      getExchangeRate: async () => {
        calls += 1;
        return 1;
      },
    });
    const coordinator = new MarketDataCoordinator(provider);

    const entry = await coordinator.loadFxRate("usd");

    expect(entry.data).toBe(1);
    expect(entry.source).toBe("static");
    expect(calls).toBe(0);
  });

  it("reuses fresh empty tab query results instead of refetching on reopen", async () => {
    let optionsCalls = 0;
    const provider = createProvider({
      getOptionsChain: async () => {
        optionsCalls += 1;
        return {
          underlyingSymbol: "AAPL",
          expirationDates: [],
          calls: [],
          puts: [],
        };
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    const firstOptions = await coordinator.loadOptions({ instrument });
    const secondOptions = await coordinator.loadOptions({ instrument });

    expect(firstOptions.error?.reasonCode).toBe("NO_DATA");
    expect(secondOptions.error?.reasonCode).toBe("NO_DATA");
    expect(optionsCalls).toBe(1);
  });

  it("force refreshes an options chain for periodic Greeks and IV updates", async () => {
    let optionsCalls = 0;
    const provider = createProvider({
      getOptionsChain: async () => {
        optionsCalls += 1;
        return {
          underlyingSymbol: "AAPL",
          expirationDates: [1_800_000_000],
          calls: [],
          puts: [],
        };
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const request = {
      instrument: { symbol: "AAPL", exchange: "NASDAQ" },
      expirationDate: 1_800_000_000,
    };

    await coordinator.loadOptions(request);
    await coordinator.loadOptions(request);
    await coordinator.loadOptions(request, { forceRefresh: true });

    expect(optionsCalls).toBe(2);
  });

  it("uses cached chart data while a wider range request is loading", async () => {
    const oneYearHistory = [
      { date: new Date("2024-01-01"), close: 100 },
      { date: new Date("2024-01-02"), close: 101 },
    ];
    const fiveYearHistory = [
      { date: new Date("2020-01-01"), close: 80 },
      ...oneYearHistory,
    ];
    let requestedFiveYear = false;
    let resolveFiveYear: (history: PricePoint[] | PromiseLike<PricePoint[]>) => void = (_history) => {
      throw new Error("expected pending 5Y request");
    };
    const provider = createProvider({
      getPriceHistory: async (_symbol, _exchange, range) => {
        if (range === "5Y") {
          return new Promise<PricePoint[]>((resolve) => {
            requestedFiveYear = true;
            resolveFiveYear = resolve;
          });
        }
        return oneYearHistory;
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    await coordinator.loadChart({
      instrument,
      bufferRange: "1Y",
      granularity: "range",
    });
    const pending = coordinator.loadChart({
      instrument,
      bufferRange: "5Y",
      granularity: "range",
    });

    const loadingEntry = coordinator.getChartEntry({
      instrument,
      bufferRange: "5Y",
      granularity: "range",
    });
    expect(loadingEntry.phase).toBe("refreshing");
    expect(loadingEntry.data?.map((point) => point.close)).toEqual([100, 101]);

    expect(requestedFiveYear).toBe(true);
    resolveFiveYear(fiveYearHistory);
    const readyEntry = await pending;
    expect(readyEntry.phase).toBe("ready");
    expect(readyEntry.data?.map((point) => point.close)).toEqual([80, 100, 101]);
  });

  it("uses cached manual-resolution data while a wider resolution range is loading", async () => {
    const oneYearHistory = [
      { date: new Date("2024-01-01"), close: 100 },
      { date: new Date("2024-01-02"), close: 101 },
    ];
    const fiveYearHistory = [
      { date: new Date("2020-01-01"), close: 80 },
      ...oneYearHistory,
    ];
    let requestedFiveYear = false;
    let resolveFiveYear: (history: PricePoint[] | PromiseLike<PricePoint[]>) => void = (_history) => {
      throw new Error("expected pending 5Y request");
    };
    const provider = createProvider({
      getPriceHistoryForResolution: async (_symbol, _exchange, range) => {
        if (range === "5Y") {
          return new Promise<PricePoint[]>((resolve) => {
            requestedFiveYear = true;
            resolveFiveYear = resolve;
          });
        }
        return oneYearHistory;
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    await coordinator.loadChart({
      instrument,
      bufferRange: "1Y",
      granularity: "resolution",
      resolution: "1d",
    });
    const pending = coordinator.loadChart({
      instrument,
      bufferRange: "5Y",
      granularity: "resolution",
      resolution: "1d",
    });

    const loadingEntry = coordinator.getChartEntry({
      instrument,
      bufferRange: "5Y",
      granularity: "resolution",
      resolution: "1d",
    });
    expect(loadingEntry.phase).toBe("refreshing");
    expect(loadingEntry.data?.map((point) => point.close)).toEqual([100, 101]);

    expect(requestedFiveYear).toBe(true);
    resolveFiveYear(fiveYearHistory);
    const readyEntry = await pending;
    expect(readyEntry.phase).toBe("ready");
    expect(readyEntry.data?.map((point) => point.close)).toEqual([80, 100, 101]);
  });

  it("normalizes descending chart history before storing it", async () => {
    const provider = createProvider({
      getPriceHistory: async () => [
        { date: new Date("2024-01-03"), close: 103 },
        { date: new Date("2024-01-01"), close: 101 },
        { date: new Date("2024-01-02"), close: 102 },
      ],
    });
    const coordinator = new MarketDataCoordinator(provider);
    const request = {
      instrument: { symbol: "AAPL", exchange: "NASDAQ" },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    };

    const entry = await coordinator.loadChart(request);

    expect(entry.data?.map((point) => point.close)).toEqual([101, 102, 103]);
  });

  it("updates the quote store from streaming events", () => {
    let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    const provider = createProvider({
      subscribeQuotes: (_targets, onQuote) => {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "MSFT", exchange: "NASDAQ" };

    coordinator.subscribeQuotes([{ instrument }]);
    const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
    if (!onStreamed) throw new Error("expected streaming callback");
    onStreamed(
      { symbol: "MSFT", exchange: "NASDAQ" },
      {
        symbol: "MSFT",
        providerId: "gloomberb-cloud",
        price: 412.5,
        currency: "USD",
        change: 3.2,
        changePercent: 0.8,
        lastUpdated: Date.now(),
      },
    );

    expect(coordinator.getQuoteEntry(instrument).data?.price).toBe(412.5);
  });

  it("reconciles stream quotes with cached provider day references before a snapshot loads", () => {
    let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    const provider = createProvider({
      getCachedFinancialsForTargets: () => new Map([[
        "VICR",
        {
          quote: {
            symbol: "VICR",
            providerId: "gloomberb-cloud",
            price: 292.83,
            currency: "USD",
            previousClose: 282.95,
            change: 9.88,
            changePercent: 3.49,
            lastUpdated: Date.parse("2026-07-06T16:54:30Z"),
            marketState: "REGULAR",
            dataSource: "live",
          },
          quoteContributions: {
            "gloomberb-cloud": {
              symbol: "VICR",
              providerId: "gloomberb-cloud",
              price: 292.83,
              currency: "USD",
              previousClose: 380.07,
              change: -87.24,
              changePercent: -22.95,
              lastUpdated: Date.parse("2026-07-06T16:54:30Z"),
              marketState: "REGULAR",
              dataSource: "live",
            },
            yahoo: {
              symbol: "VICR",
              providerId: "yahoo",
              price: 294.39,
              currency: "USD",
              previousClose: 282.95,
              change: 11.44,
              changePercent: 4.04,
              lastUpdated: Date.parse("2026-07-06T16:45:37Z"),
              marketState: "REGULAR",
              dataSource: "delayed",
            },
          },
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
        },
      ]]),
      subscribeQuotes: (_targets, onQuote) => {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = {
      symbol: "VICR",
      exchange: "NASDAQ",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        conId: 275759,
        symbol: "VICR",
      },
    };

    coordinator.subscribeQuotes([{ instrument }]);
    const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
    if (!onStreamed) throw new Error("expected streaming callback");
    onStreamed(
      {
        symbol: "VICR",
        exchange: "NASDAQ",
        context: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-work",
          instrument: instrument.instrument,
        },
      },
      {
        symbol: "VICR",
        providerId: "gloomberb-cloud",
        price: 293.07,
        currency: "USD",
        previousClose: 380.07,
        change: -87,
        changePercent: -22.89,
        lastUpdated: Date.parse("2026-07-06T17:17:00Z"),
        marketState: "REGULAR",
        dataSource: "live",
      },
    );

    const quote = coordinator.getQuoteEntry(instrument).data;
    expect(quote?.price).toBe(293.07);
    expect(quote?.previousClose).toBe(282.95);
    expect(quote?.changePercent).toBeCloseTo(((293.07 - 282.95) / 282.95) * 100, 10);
    expect(quote?.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
  });

  it("reconciles batch quote loads with cached provider day references before a snapshot loads", async () => {
    const provider = createProvider({
      getCachedFinancialsForTargets: () => new Map([[
        "VICR",
        {
          quote: {
            symbol: "VICR",
            providerId: "gloomberb-cloud",
            price: 292.83,
            currency: "USD",
            previousClose: 282.95,
            change: 9.88,
            changePercent: 3.49,
            lastUpdated: Date.parse("2026-07-06T16:54:30Z"),
            marketState: "REGULAR",
            dataSource: "live",
          },
          quoteContributions: {
            "gloomberb-cloud": {
              symbol: "VICR",
              providerId: "gloomberb-cloud",
              price: 292.83,
              currency: "USD",
              previousClose: 380.07,
              change: -87.24,
              changePercent: -22.95,
              lastUpdated: Date.parse("2026-07-06T16:54:30Z"),
              marketState: "REGULAR",
              dataSource: "live",
            },
            yahoo: {
              symbol: "VICR",
              providerId: "yahoo",
              price: 294.39,
              currency: "USD",
              previousClose: 282.95,
              change: 11.44,
              changePercent: 4.04,
              lastUpdated: Date.parse("2026-07-06T16:45:37Z"),
              marketState: "REGULAR",
              dataSource: "delayed",
            },
          },
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
        },
      ]]),
      getQuotesBatch: async (targets) => targets.map((target) => ({
        target,
        quote: {
          symbol: target.symbol,
          providerId: "gloomberb-cloud",
          price: 293.07,
          currency: "USD",
          previousClose: 380.07,
          change: -87,
          changePercent: -22.89,
          lastUpdated: Date.parse("2026-07-06T17:17:00Z"),
          marketState: "REGULAR",
          dataSource: "live",
        },
      })),
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = {
      symbol: "VICR",
      exchange: "NASDAQ",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        conId: 275759,
        symbol: "VICR",
      },
    };

    await coordinator.loadQuotesBatch([instrument], { forceRefresh: true });

    const quote = coordinator.getQuoteEntry(instrument).data;
    expect(quote?.price).toBe(293.07);
    expect(quote?.previousClose).toBe(282.95);
    expect(quote?.changePercent).toBeCloseTo(((293.07 - 282.95) / 282.95) * 100, 10);
    expect(quote?.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
  });

  it("preserves requested quote stream routes", () => {
    let subscribedTargets: QuoteSubscriptionTarget[] = [];
    const provider = createProvider({
      subscribeQuotes: (targets) => {
        subscribedTargets = targets;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);

    coordinator.subscribeQuotes([{
      instrument: {
        symbol: "AAPL",
        exchange: "NASDAQ",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
      },
      priority: { route: "provider", surface: "portfolio", visible: true },
    }]);

    expect(subscribedTargets).toEqual([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      route: "provider",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        instrument: null,
      },
      surface: "portfolio",
      visible: true,
    }]);
  });

  it("routes manual-resolution chart requests through the resolution-aware provider path", async () => {
    let requested: { range: string; resolution: string } | null = null;
    const provider = createProvider({
      getPriceHistoryForResolution: async (_symbol, _exchange, range, resolution) => {
        requested = { range, resolution };
        return [
          { date: new Date("2024-01-01"), close: 100 },
          { date: new Date("2024-01-02"), close: 101 },
        ];
      },
    });
    const coordinator = new MarketDataCoordinator(provider);

    const entry = await coordinator.loadChart({
      instrument: { symbol: "AAPL", exchange: "NASDAQ" },
      bufferRange: "1Y",
      granularity: "resolution",
      resolution: "1d",
    });

    expect(requested as { range: string; resolution: string } | null).toEqual({ range: "1Y", resolution: "1d" });
    expect(entry.data?.length).toBe(2);
  });

  it("projects live quote updates into premarket display fields when the stream lacks explicit ext-hours fields", async () => {
    let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    const provider = createProvider({
      getTickerFinancials: async () => ({
        quote: {
          symbol: "AAPL",
          price: 100,
          currency: "USD",
          change: -1,
          changePercent: -1,
          lastUpdated: 1_700_000_000_000,
          marketState: "PRE",
          preMarketPrice: 101,
          preMarketChange: 0,
          preMarketChangePercent: 0,
        },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
      }),
      subscribeQuotes: (_targets, onQuote) => {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "ibkr-live" };

    await coordinator.loadSnapshot(instrument);
    coordinator.subscribeQuotes([{ instrument }]);
    const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
    if (!onStreamed) throw new Error("expected streaming callback");
    onStreamed(
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        context: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-live",
          instrument: null,
        },
      },
      {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 103.5,
        currency: "USD",
        change: 2.5,
        changePercent: 2.48,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    );

    const quote = coordinator.getTickerFinancialsSync(instrument)?.quote;
    expect(quote?.marketState).toBe("PRE");
    expect(quote?.preMarketPrice).toBe(103.5);
    expect(quote?.preMarketChange).toBe(2.5);
    expect(quote?.preMarketChangePercent).toBe(2.48);
  });

  it("keeps the snapshot quote when a quote-only refresh is off by a likely 100x unit mismatch", async () => {
    const provider = createProvider({
      getTickerFinancials: async () => ({
        quote: {
          symbol: "IQE.L",
          price: 0.245,
          currency: "GBP",
          change: -0.021,
          changePercent: -7.89,
          lastUpdated: Date.now() - 1000,
          dataSource: "delayed",
        },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
      }),
      getQuote: async () => ({
        symbol: "IQE",
        providerId: "gloomberb-cloud",
        price: 24.5,
        currency: "GBP",
        change: -2.1,
        changePercent: -7.89,
        lastUpdated: Date.now(),
        dataSource: "live",
      }),
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "IQE", exchange: "LSE" };

    await coordinator.loadSnapshot(instrument);
    await coordinator.loadQuote(instrument);

    expect(coordinator.getQuoteEntry(instrument).data?.price).toBe(24.5);
    expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.price).toBe(0.245);
    expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.symbol).toBe("IQE.L");
  });

  it("keeps the snapshot quote when a streaming update is off by a likely 100x unit mismatch", async () => {
    let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
    const provider = createProvider({
      getTickerFinancials: async () => ({
        quote: {
          symbol: "IQE.L",
          price: 0.245,
          currency: "GBP",
          change: -0.021,
          changePercent: -7.89,
          lastUpdated: Date.now() - 1000,
          dataSource: "delayed",
        },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
      }),
      subscribeQuotes: (_targets, onQuote) => {
        streamed = onQuote as typeof streamed;
        return () => {};
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "IQE", exchange: "LSE" };

    await coordinator.loadSnapshot(instrument);
    coordinator.subscribeQuotes([{ instrument }]);
    const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
    if (!onStreamed) throw new Error("expected streaming callback");
    onStreamed(
      { symbol: "IQE", exchange: "LSE" },
      {
        symbol: "IQE",
        providerId: "gloomberb-cloud",
        price: 24.5,
        currency: "GBP",
        change: -2.1,
        changePercent: -7.89,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    );

    expect(coordinator.getQuoteEntry(instrument).data?.price).toBe(24.5);
    expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.price).toBe(0.245);
  });

  it("keeps the fresh snapshot quote when a stale cloud stream update arrives later", async () => {
    const fixedNow = Date.parse("2026-04-08T10:30:00Z");
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
      const provider = createProvider({
        getTickerFinancials: async () => ({
          quote: {
            symbol: "HY9H",
            providerId: "yahoo",
            dataSource: "delayed",
            price: 598,
            currency: "EUR",
            change: 6,
            changePercent: 1.01,
            lastUpdated: Date.parse("2026-04-08T10:25:00Z"),
            listingExchangeName: "FWB2",
            marketState: "REGULAR",
            sessionConfidence: "derived",
          },
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
        }),
        subscribeQuotes: (_targets, onQuote) => {
          streamed = onQuote as typeof streamed;
          return () => {};
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const instrument = { symbol: "HY9H", exchange: "FWB2" };

      await coordinator.loadSnapshot(instrument);
      coordinator.subscribeQuotes([{ instrument }]);
      const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
      if (!onStreamed) throw new Error("expected streaming callback");
      onStreamed(
        { symbol: "HY9H", exchange: "FWB2" },
        {
          symbol: "HY9H",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
          price: 528,
          currency: "EUR",
          change: 4,
          changePercent: 0.76,
          lastUpdated: Date.parse("2026-04-07T17:55:00Z"),
          listingExchangeName: "FWB2",
          marketState: "REGULAR",
          sessionConfidence: "explicit",
        },
      );

      expect(coordinator.getQuoteEntry(instrument).data).toBeNull();
      expect(coordinator.getQuoteEntry(instrument).lastGoodData?.price).toBe(598);
      expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.price).toBe(598);
      expect(coordinator.getTickerFinancialsSync(instrument)?.quote?.providerId).toBe("yahoo");
    } finally {
      Date.now = realDateNow;
    }
  });

  it("drops a stale stream quote when there is no fresh quote to preserve", () => {
    const fixedNow = Date.parse("2026-05-13T21:00:00Z");
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      let streamed: ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null = null;
      const provider = createProvider({
        subscribeQuotes: (_targets, onQuote) => {
          streamed = onQuote as typeof streamed;
          return () => {};
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const instrument = { symbol: "2337", exchange: "TWSE" };

      coordinator.subscribeQuotes([{ instrument }]);
      const onStreamed = streamed as ((target: QuoteSubscriptionTarget, quote: Quote) => void) | null;
      if (!onStreamed) throw new Error("expected streaming callback");
      onStreamed(
        { symbol: "2337", exchange: "TWSE" },
        {
          symbol: "2337",
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
          price: 150,
          currency: "TWD",
          change: 0,
          changePercent: 0,
          lastUpdated: Date.parse("2026-05-08T06:00:00Z"),
          listingExchangeName: "TWSE",
          marketState: "CLOSED",
          sessionConfidence: "explicit",
        },
      );

      const entry = coordinator.getQuoteEntry(instrument);
      expect(entry.data).toBeNull();
      expect(entry.lastGoodData).toBeNull();
      expect(coordinator.getTickerFinancialsSync(instrument)?.quote).toBeUndefined();
    } finally {
      Date.now = realDateNow;
    }
  });

  it("hydrates ticker financials synchronously from primed cached data", () => {
    const coordinator = new MarketDataCoordinator(createProvider());
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    coordinator.primeCachedFinancials([{
      instrument,
      financials: {
        quote: {
          symbol: "AAPL",
          price: 246.63,
          currency: "USD",
          change: -2.17,
          changePercent: -0.87,
          marketCap: 3_640_775_908_600,
          lastUpdated: 1_700_000_000_000,
        },
        fundamentals: {
          trailingPE: 31.4,
          forwardPE: 27.8,
        },
        profile: {
          sector: "Technology",
        },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 248.8 }],
      },
    }]);

    const financials = coordinator.getTickerFinancialsSync(instrument);
    expect(financials?.quote?.marketCap).toBe(3_640_775_908_600);
    expect(financials?.fundamentals?.trailingPE).toBe(31.4);
    expect(financials?.priceHistory[0]?.close).toBe(248.8);
  });

  it("merges live quote data with primed cached financials during resume", async () => {
    const provider = createProvider({
      getQuote: async () => ({
        symbol: "AAPL",
        price: 246.63,
        currency: "USD",
        change: -2.17,
        changePercent: -0.87,
        lastUpdated: 1_700_000_001_000,
      }),
    });
    const coordinator = new MarketDataCoordinator(provider);
    const instrument = { symbol: "AAPL", exchange: "NASDAQ" };

    coordinator.primeCachedFinancials([{
      instrument,
      financials: {
        quote: {
          symbol: "AAPL",
          price: 248.8,
          currency: "USD",
          change: 0,
          changePercent: 0,
          marketCap: 3_640_775_908_600,
          lastUpdated: 1_700_000_000_000,
        },
        fundamentals: {
          trailingPE: 31.4,
        },
        profile: {
          sector: "Technology",
        },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [],
      },
    }]);
    await coordinator.loadQuote(instrument);

    const financials = coordinator.getTickerFinancialsSync(instrument);
    expect(financials?.quote?.price).toBe(246.63);
    expect(financials?.quote?.marketCap).toBe(3_640_775_908_600);
    expect(financials?.fundamentals?.trailingPE).toBe(31.4);
  });

  it("batch loads only missing quotes when fresh quote data is already stored", async () => {
    const batchTargets: QuoteSubscriptionTarget[][] = [];
    const provider = createProvider({
      getQuote: async () => ({
        symbol: "AAPL",
        price: 100,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.now(),
      }),
      getQuotesBatch: async (targets) => {
        batchTargets.push(targets);
        return targets.map((target) => ({
          target,
          quote: {
            symbol: target.symbol,
            price: target.symbol === "MSFT" ? 200 : 300,
            currency: "USD",
            change: 0,
            changePercent: 0,
            lastUpdated: Date.now(),
          },
        }));
      },
    });
    const coordinator = new MarketDataCoordinator(provider);
    const aapl = { symbol: "AAPL", exchange: "NASDAQ" };
    const msft = { symbol: "MSFT", exchange: "NASDAQ" };

    await coordinator.loadQuote(aapl);
    await coordinator.loadQuotesBatch([aapl, msft]);

    expect(batchTargets).toHaveLength(1);
    expect(batchTargets[0]?.map((target) => target.symbol)).toEqual(["MSFT"]);
    expect(coordinator.getQuoteEntry(aapl).data?.price).toBe(100);
    expect(coordinator.getQuoteEntry(msft).data?.price).toBe(200);
  });

  it("refreshes primed quote cache when the quote is stale for the current session", async () => {
    const fixedNow = Date.parse("2026-05-13T21:00:00Z");
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const batchTargets: QuoteSubscriptionTarget[][] = [];
      const provider = createProvider({
        getQuotesBatch: async (targets) => {
          batchTargets.push(targets);
          return targets.map((target) => ({
            target,
            quote: {
              symbol: target.symbol,
              price: 6970,
              currency: "JPY",
              change: 370,
              changePercent: 5.61,
              lastUpdated: Date.parse("2026-05-13T06:24:00Z"),
              marketState: "CLOSED",
              listingExchangeName: "JPX",
              providerId: "yahoo",
            },
          }));
        },
      });
      const coordinator = new MarketDataCoordinator(provider);
      const instrument = { symbol: "6324.T", exchange: "JPX" };

      coordinator.primeCachedFinancials([{
        instrument,
        financials: {
          quote: {
            symbol: "6324.T",
            price: 6230,
            currency: "JPY",
            change: 520,
            changePercent: 9.11,
            lastUpdated: Date.parse("2026-05-08T06:24:00Z"),
            marketState: "CLOSED",
            listingExchangeName: "JPX",
            providerId: "gloomberb-cloud",
          },
          annualStatements: [],
          quarterlyStatements: [],
          priceHistory: [],
        },
      }]);

      await coordinator.loadQuotesBatch([instrument]);

      expect(batchTargets).toHaveLength(1);
      expect(batchTargets[0]?.map((target) => target.symbol)).toEqual(["6324.T"]);
      expect(coordinator.getQuoteEntry(instrument).data?.price).toBe(6970);
      expect(coordinator.getQuoteEntry(instrument).data?.changePercent).toBe(5.61);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("batch loads snapshots through provider batch support", async () => {
    const batchSymbols: string[][] = [];
    const provider = createProvider({
      getTickerFinancialsBatch: async (targets) => {
        batchSymbols.push(targets.map((target) => target.symbol));
        return targets.map((target) => ({
          target,
          financials: {
            quote: {
              symbol: target.symbol,
              price: target.symbol === "AAPL" ? 150 : 250,
              currency: "USD",
              change: 0,
              changePercent: 0,
              lastUpdated: 1_700_000_000_000,
            },
            fundamentals: { trailingPE: target.symbol === "AAPL" ? 20 : 30 },
            annualStatements: [],
            quarterlyStatements: [],
            priceHistory: [],
          },
        }));
      },
    });
    const coordinator = new MarketDataCoordinator(provider);

    await coordinator.loadSnapshotsBatch([
      { symbol: "AAPL", exchange: "NASDAQ" },
      { symbol: "MSFT", exchange: "NASDAQ" },
    ]);

    expect(batchSymbols).toEqual([["AAPL", "MSFT"]]);
    expect(coordinator.getTickerFinancialsSync({ symbol: "AAPL", exchange: "NASDAQ" })?.quote?.price).toBe(150);
    expect(coordinator.getTickerFinancialsSync({ symbol: "MSFT", exchange: "NASDAQ" })?.fundamentals?.trailingPE).toBe(30);
  });
});
