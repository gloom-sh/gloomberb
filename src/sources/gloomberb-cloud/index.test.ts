import { afterEach, describe, expect, test } from "bun:test";
import { createGloomberbCloudCapabilities, GloomberbCloudProvider } from "./index";
import { toHistoryRequest } from "./normalizers";
import { subtractTimeRange } from "../../time-series/date-window";
import type { NewsCapability } from "../../capabilities";
import { apiClient, type AuthUser, type CloudNewsPayload } from "../../api-client";
import { cloudNewsParams } from "./news";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { ProviderMissError } from "../provider-errors";

const verifiedUser: AuthUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  username: "test",
  emailVerified: true,
  image: null,
  createdAt: "2026-03-30T00:00:00.000Z",
  updatedAt: "2026-03-30T00:00:00.000Z",
};

const originalEnsureVerifiedSession = apiClient.ensureVerifiedSession.bind(apiClient);
const originalGetCloudSecFilings = apiClient.getCloudSecFilings.bind(apiClient);
const originalGetCloudHistory = apiClient.getCloudHistory.bind(apiClient);
const originalGetCloudQuote = apiClient.getCloudQuote.bind(apiClient);
const originalGetCloudFinancials = apiClient.getCloudFinancials.bind(apiClient);
const originalGetCloudQuotesBatch = apiClient.getCloudQuotesBatch.bind(apiClient);
const originalGetCloudFinancialsBatch = apiClient.getCloudFinancialsBatch.bind(apiClient);
const originalGetCloudExchangeRate = apiClient.getCloudExchangeRate.bind(apiClient);
const originalGetCloudHolders = apiClient.getCloudHolders.bind(apiClient);
const originalGetCloudAnalystResearch = apiClient.getCloudAnalystResearch.bind(apiClient);
const originalGetCloudCorporateActions = apiClient.getCloudCorporateActions.bind(apiClient);
const originalGetCloudOptionsChain = apiClient.getCloudOptionsChain.bind(apiClient);
const originalGetCloudNews = apiClient.getCloudNews.bind(apiClient);
const originalGetCloudNewsStory = apiClient.getCloudNewsStory.bind(apiClient);
const originalSubscribeQuotes = apiClient.subscribeQuotes.bind(apiClient);

test("sparse single and batch SAP responses withdraw the captured observation before caching", async () => {
  const data = { annualStatements: [], quarterlyStatements: [], priceHistory: [], fundamentals: {
    source: "twelvedata", marketCapCurrency: "USD", sharesOutstanding: 1_154_204_232,
    enterpriseValue: 4_095_338_359_014, enterpriseToRevenue: 92.879, revenue: 44_093_047_102,
  } };
  apiClient.getCloudFinancials = async () => ({ status: "partial", data });
  apiClient.getCloudFinancialsBatch = async (requests) => ({ status: "success", data: { items:
    requests.map((target) => ({ ...target, status: "partial", data })),
  } });
  const provider = new GloomberbCloudProvider();
  const targets = [{ symbol: "SAP:XNYS" }, { symbol: "SAP", exchange: "NYSE" }, { symbol: "SAP" }];
  const values = [
    ...await Promise.all(targets.map((target) => provider.getTickerFinancials(target.symbol, target.exchange))),
    ...await provider.getTickerFinancialsBatch(targets).then((items) => items.map((item) => item.financials!)),
  ];
  expect(values).toHaveLength(6);
  for (const value of values) {
    expect(value.fundamentals?.enterpriseValue).toBeUndefined();
    expect(value.fundamentals?.enterpriseToRevenue).toBeUndefined();
    expect(value.fundamentals?.unavailableFields).toEqual(["enterpriseValue", "enterpriseToRevenue"]);
    expect(value.fundamentals?.revenue).toBe(44_093_047_102);
  }
  // The request cannot override source-declared foreign identity.
  apiClient.getCloudFinancials = async () => ({ status: "partial", data: { ...data, quoteMetadata: {
    symbol: "SAP", listingExchangeName: "XETRA", currency: "EUR", source: { providerId: "gloomberb-cloud" },
  } } });
  expect((await provider.getTickerFinancials("SAP:XNYS")).fundamentals?.enterpriseValue).toBe(4_095_338_359_014);
});

test("requests fifty years of cloud history for the ALL range", () => {
  const endDate = new Date("2026-07-30T20:00:00.000Z");

  expect(subtractTimeRange(endDate, "ALL").toISOString()).toBe("1976-07-30T20:00:00.000Z");
  expect(toHistoryRequest("ALL")).toEqual({
    interval: "1month",
    outputsize: 600,
    rangeKey: "ALL",
  });
});

test("news lookup shares the canonical listing across public and Yahoo deep-link aliases", () => {
  for (const ticker of ["VOD:XLON", "VOD.L"]) {
    expect(cloudNewsParams({ scope: "ticker", ticker, exchange: "LSE" }))
      .toMatchObject({ ticker: "VOD", exchange: "XLON" });
  }
  expect(cloudNewsParams({ scope: "ticker", ticker: "BRK.B", exchange: "NYSE" }))
    .toMatchObject({ ticker: "BRK.B", exchange: "XNYS" });
  expect(cloudNewsParams({ scope: "ticker", ticker: "VOD.L", exchange: "NASDAQ" }))
    .toMatchObject({ ticker: "VOD.L", exchange: "XNAS" });
});

function makeCloudNewsPayload(overrides: Partial<CloudNewsPayload> = {}): CloudNewsPayload {
  return {
    id: "story-1",
    headline: "Apple raises guidance",
    summary: "Apple lifted its outlook after stronger iPhone demand.",
    topic: "guidance",
    topics: ["guidance"],
    category: "guidance",
    sentiment: "positive",
    sectors: ["information_technology"],
    firstPublishedAt: "2026-04-01T10:00:00.000Z",
    lastPublishedAt: "2026-04-01T10:05:00.000Z",
    firstSeenAt: "2026-04-01T10:00:10.000Z",
    lastSeenAt: "2026-04-01T10:05:10.000Z",
    primaryUrl: "https://example.com/aapl-guidance",
    primarySource: "example-wire",
    scores: {
      importance: 91,
      urgency: 74,
      marketImpact: 88,
      novelty: 86,
      confidence: 95,
    },
    flags: {
      breaking: true,
      developing: false,
      stale: false,
    },
    variantCount: 1,
    sourceCount: 1,
    sources: ["example-wire"],
    entities: [],
    tickerLinks: [{
      symbol: "AAPL",
      exchange: "XNAS",
      canonicalTicker: "AAPL:XNAS",
      relationType: "direct",
      displayTier: "primary",
      confidence: 0.98,
      relevanceScore: 95,
      impactScore: 93,
      sentiment: "positive",
    }],
    ...overrides,
  };
}

afterEach(() => {
  apiClient.ensureVerifiedSession = originalEnsureVerifiedSession;
  apiClient.getCloudSecFilings = originalGetCloudSecFilings;
  apiClient.getCloudHistory = originalGetCloudHistory;
  apiClient.getCloudQuote = originalGetCloudQuote;
  apiClient.getCloudFinancials = originalGetCloudFinancials;
  apiClient.getCloudQuotesBatch = originalGetCloudQuotesBatch;
  apiClient.getCloudFinancialsBatch = originalGetCloudFinancialsBatch;
  apiClient.getCloudExchangeRate = originalGetCloudExchangeRate;
  apiClient.getCloudHolders = originalGetCloudHolders;
  apiClient.getCloudAnalystResearch = originalGetCloudAnalystResearch;
  apiClient.getCloudCorporateActions = originalGetCloudCorporateActions;
  apiClient.getCloudOptionsChain = originalGetCloudOptionsChain;
  apiClient.getCloudNews = originalGetCloudNews;
  apiClient.getCloudNewsStory = originalGetCloudNewsStory;
  apiClient.subscribeQuotes = originalSubscribeQuotes;
});

describe("GloomberbCloudProvider", () => {
  test("discovers an unqualified venue without merging unresolved suffixes or ambiguous listings", async () => {
    const provider = new GloomberbCloudProvider();
    const quote = { symbol: "SPY", price: 1, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 };
    const spy = { symbol: "SPY" };
    let items = [{ symbol: "SPY", exchange: "ARCA", status: "success" as const, data: quote }];
    apiClient.getCloudQuotesBatch = async () => ({ status: "success", data: { items } });
    apiClient.ensureVerifiedSession = async () => null;
    apiClient.subscribeQuotes = (_targets, onQuote) => {
      for (const item of items) onQuote(item, item.data);
      return () => {};
    };
    expect((await provider.getQuotesBatch([spy]))[0]).toMatchObject({ target: spy, quote: { symbol: "SPY" } });
    const seen: QuoteSubscriptionTarget[] = [];
    provider.subscribeQuotes([spy], (target) => seen.push(target))();
    expect(seen).toEqual([spy]);
    items = [...items, { ...items[0]!, exchange: "NYSE" }];
    expect((await provider.getQuotesBatch([spy]))[0]?.quote).toBeNull();
    for (const targets of [[spy, { symbol: "SPY:XNAS" }], [{ symbol: "AIR.NZ" }, { symbol: "AIR.VI" }]]) {
      items = [{ symbol: targets[0]!.symbol === "SPY" ? "SPY" : "AIR", exchange: "ARCA", status: "success", data: quote }];
      const results = await provider.getQuotesBatch(targets);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.quote === null && result.error instanceof ProviderMissError)).toBe(true);
      provider.subscribeQuotes(targets, () => { throw new Error("ambiguous listing delivered"); })();
    }
  });

  test("uses host venue aliases at the cloud boundary without losing suffix or non-equity identity", async () => {
    const requests: Array<[string, string | undefined]> = [];
    apiClient.getCloudQuote = async (symbol, exchange) => {
      requests.push([symbol, exchange]);
      return { status: "success", data: { symbol, price: 1, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 } };
    };
    const cases = [
      ["RY", "TSE", "RY", "TSX"], ["RY:TSE", "", "RY", "TSX"],
      ["7203", "TSEJ", "7203", "JPX"], ["7203.T:JPX", "NASDAQ", "7203.T", "JPX"],
      ["7203.T:TSEJ", "", "7203.T", "JPX"], ["RY.TO:XTSE", "", "RY.TO", "TSX"],
      ["NVDA", "XNAS", "NVDA", "NASDAQ"], ["SPY:ARCX", "", "SPY", "ARCA"],
      ["VOD.L:XLON", "", "VOD.L", "LSE"], ["AIR.NZ:XNZE", "", "AIR.NZ", "NZX"],
      ["OMV.VI:XWBO", "", "OMV.VI", "VIE"], ["WALMEX.MX:XMEX", "", "WALMEX.MX", "BMV"],
      ["ABC.V:XTSX", "", "ABC.V", "TSXV"], ["EQNR.OL:XOSL", "", "EQNR.OL", "OSL"],
      ["CEZ.PR:XPRA", "", "CEZ.PR", "PSE"], ["AC.PS", "", "AC.PS", ""],
      ["BRK.B:XNYS", "", "BRK.B", "NYSE"], ["BTC-USD", "CCC", "BTC-USD", "CCC"],
      ["EURUSD=X", "CCY", "EURUSD=X", "CCY"], ["ES=F", "CME", "ES=F", "CME"],
      // A bare suffix remains authoritative over generic/stale exchange metadata.
      ["7203.T", "NASDAQ", "7203.T", "JPX"], ["AIR.NZ:UNKNOWN", "", "AIR.NZ", "UNKNOWN"],
    ];
    const provider = new GloomberbCloudProvider();
    for (const [symbol, exchange, requestSymbol, requestExchange] of cases) {
      expect((await provider.getQuote(symbol!, exchange)).symbol).toBe(symbol!);
      expect(requests.at(-1)).toEqual([requestSymbol, requestExchange]);
    }
  });

  test("rejects contradictory qualified listings before quote, research, history or auth transport", async () => {
    let calls = 0;
    apiClient.ensureVerifiedSession = async () => { calls++; return verifiedUser; };
    const forbidden = async () => { calls++; throw new Error("unexpected transport"); };
    apiClient.getCloudQuote = forbidden;
    apiClient.getCloudFinancials = forbidden;
    apiClient.getCloudHistory = forbidden;
    apiClient.getCloudOptionsChain = forbidden;
    const provider = new GloomberbCloudProvider();
    for (const symbol of ["7203.T:TSE", "RY.TO:JPX", "VOD.L:XNAS"]) {
      for (const run of [
        () => provider.getQuote(symbol), () => provider.getQuoteMetadata(symbol),
        () => provider.getTickerFinancials(symbol), () => provider.getHolders(symbol),
        () => provider.getAnalystResearch(symbol), () => provider.getCorporateActions(symbol),
        () => provider.getPriceHistory(symbol, "", "1M"),
        () => provider.getPriceHistoryForResolution(symbol, "", "1M", "1d"),
        () => provider.getDetailedPriceHistory(symbol, "", new Date("2026-01-01"), new Date("2026-09-01"), "1d"),
        () => provider.getOptionsChain(symbol),
      ]) await expect(run()).rejects.toBeInstanceOf(ProviderMissError);
    }
    expect(calls).toBe(0);
  });

  test("isolates a conflicting listing in reordered batches and preserves valid stream target context", async () => {
    const targets: QuoteSubscriptionTarget[] = [
      { symbol: "7203.T:TSE", exchange: "JPX" },
      { symbol: "RY", exchange: "TSE", route: "broker", surface: "portfolio", visible: true,
        context: { brokerId: "ibkr", instrument: { brokerId: "ibkr", symbol: "RY", conId: 123, primaryExchange: "TSE", currency: "CAD" } } },
      { symbol: "7203.T", exchange: "TSE", surface: "detail", selected: true, weight: 9 },
    ];
    const requests = [{ symbol: "RY", exchange: "TSX" }, { symbol: "7203.T", exchange: "JPX" }];
    const quote = { symbol: "RY", price: 1, currency: "CAD", change: 0, changePercent: 0, lastUpdated: 1 };
    const items = [
      { symbol: "7203", exchange: "JPX", status: "success" as const, data: { ...quote, symbol: "7203", currency: "JPY" } },
      { symbol: "RY", exchange: "TSX", status: "success" as const, data: quote },
    ];
    let batchCalls = 0, streamCalls = 0, authCalls = 0;
    apiClient.getCloudQuotesBatch = async (submitted, mode) => {
      batchCalls++; expect(submitted).toEqual(requests); expect(mode).toBe("refresh");
      return { status: "success", data: { items } };
    };
    apiClient.getCloudFinancialsBatch = async (submitted, mode) => {
      batchCalls++; expect(submitted).toEqual(requests); expect(mode).toBe("refresh");
      return { status: "success", data: { items: items.map((item) => ({ ...item,
        data: { quote: item.data, annualStatements: [], quarterlyStatements: [], priceHistory: [] } })) } };
    };
    apiClient.ensureVerifiedSession = async () => { authCalls++; return verifiedUser; };
    apiClient.subscribeQuotes = (submitted, onQuote) => {
      streamCalls++;
      expect(submitted).toEqual(requests.map((request, i) => ({ ...request,
        surface: targets[i + 1]!.surface, visible: targets[i + 1]!.visible,
        selected: targets[i + 1]!.selected, weight: targets[i + 1]!.weight })));
      for (const item of items) onQuote(item, item.data);
      return () => {};
    };
    const provider = new GloomberbCloudProvider();
    for (const batch of [await provider.getQuotesBatch(targets, { forceRefresh: true }),
      await provider.getTickerFinancialsBatch(targets, { forceRefresh: true })]) {
      expect(batch[0]!.target).toBe(targets[0]!);
      expect(batch[0]!.error).toBeInstanceOf(ProviderMissError);
      expect(batch[1]!.target).toBe(targets[2]!);
      expect(batch[2]!.target).toBe(targets[1]!);
    }
    const seen: QuoteSubscriptionTarget[] = [];
    provider.subscribeQuotes(targets, (target, value) => {
      seen.push(target); expect(value.symbol).toBe(target.symbol);
    })();
    expect(seen[0]).toBe(targets[2]!);
    expect(seen[1]).toBe(targets[1]!);
    for (const batch of [await provider.getQuotesBatch([targets[0]!]),
      await provider.getTickerFinancialsBatch([targets[0]!])]) {
      expect(batch).toHaveLength(1); expect(batch[0]!.error).toBeInstanceOf(ProviderMissError);
    }
    provider.subscribeQuotes([targets[0]!], () => { throw new Error("invalid target delivered"); })();
    expect([batchCalls, streamCalls, authCalls]).toEqual([2, 1, 1]);
  });

  test("stale items in a successful quote batch cannot bypass single-quote freshness checks", async () => {
    const targets = [{ symbol: "VOD", exchange: "NASDAQ" }, { symbol: "VOD:XLON", exchange: "LSE" }];
    const quote = { symbol: "VOD", price: 118, currency: "GBp", change: 1, changePercent: 0.85, lastUpdated: 1, stale: false };
    for (const status of ["success", "partial"] as const) {
      apiClient.getCloudQuotesBatch = async () => ({ status: "success", stale: false, data: { items: [
        { symbol: "VOD", exchange: "LSE", status, stale: true, data: quote },
        { symbol: "VOD", exchange: "NASDAQ", status: "success", stale: false, data: { ...quote, price: 15, currency: "USD" } },
      ] } });
      apiClient.getCloudQuote = async () => ({ status, stale: true, data: quote });
      const provider = new GloomberbCloudProvider();
      const results = await provider.getQuotesBatch(targets);
      expect(results[0]?.target).toBe(targets[1]!);
      expect(results[0]?.quote).toBeNull();
      expect(results[0]?.error?.message).toContain("stale");
      expect(results[1]?.target).toBe(targets[0]!);
      expect(results[1]?.quote).toMatchObject({ symbol: "VOD", currency: "USD", price: 15 });
      await expect(provider.getQuote("VOD:XLON", "LSE")).rejects.toThrow("stale");
    }
  });

  test("splits saved listing keys for cloud requests while preserving returned ticker identity", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const quote = { symbol: "VOD", price: 118, currency: "GBp", change: 1, changePercent: 0.85, lastUpdated: 1 };
    apiClient.getCloudQuote = async (symbol, exchange) => {
      calls.push(["quote", symbol, exchange]);
      return { status: "success", data: quote };
    };
    apiClient.getCloudFinancials = async (symbol, exchange) => {
      calls.push(["financials", symbol, exchange]);
      return { status: "success", data: { quote, annualStatements: [{ date: "2025-03-31", currency: "EUR", totalRevenue: 10 }], quarterlyStatements: [], priceHistory: [] } };
    };
    apiClient.getCloudHistory = async (symbol, exchange) => {
      calls.push(["history", symbol, exchange]);
      return { status: "success", currency: "GBp", data: [{ date: "2026-09-10 10:00:00", close: 118 }] };
    };
    const provider = new GloomberbCloudProvider();
    expect(await provider.getQuote("VOD:XLON", "NASDAQ")).toMatchObject({ symbol: "VOD:XLON", currency: "GBP", price: 1.18 });
    const financials = await provider.getTickerFinancials("VOD:XLON", "NASDAQ");
    expect(financials.quote?.symbol).toBe("VOD:XLON");
    expect(financials.annualStatements).toHaveLength(1);
    const history = await provider.getPriceHistory("VOD:XLON", "NASDAQ", "1M");
    expect(history[0]?.close).toBe(1.18);
    expect(history[0]?.date.toISOString()).toBe("2026-09-10T09:00:00.000Z");
    await provider.getPriceHistoryForResolution("VOD:XLON", "NASDAQ", "1M", "1d");
    await provider.getDetailedPriceHistory("VOD:XLON", "NASDAQ", new Date("2026-09-01"), new Date("2026-09-10"), "1d");
    expect(calls).toEqual(["quote", "financials", "history", "history", "history"].map((kind) => [kind, "VOD", "LSE"]));
  });

  test("keeps US and UK saved listings distinct through reordered cloud batches and quote streams", async () => {
    const targets = [{ symbol: "VOD", exchange: "NASDAQ" }, { symbol: "VOD:XLON", exchange: "LSE" }];
    const quote = { symbol: "VOD", price: 118, currency: "GBp", change: 1, changePercent: 0.85, lastUpdated: 1 };
    const expectedRequests = [{ symbol: "VOD", exchange: "NASDAQ" }, { symbol: "VOD", exchange: "LSE" }];
    apiClient.getCloudQuotesBatch = async (requests) => {
      expect(requests).toEqual(expectedRequests);
      return { status: "success", data: { items: [
        { symbol: "VOD", exchange: "LSE", status: "success", data: quote },
        { symbol: "VOD", exchange: "NASDAQ", status: "success", data: { ...quote, price: 15, currency: "USD" } },
      ] } };
    };
    apiClient.getCloudFinancialsBatch = async (requests) => {
      expect(requests).toEqual(expectedRequests);
      return { status: "success", data: { items: [{ symbol: "VOD", exchange: "LSE", status: "success", data: { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } }] } };
    };
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.subscribeQuotes = (requests, onQuote) => {
      expect(requests.map(({ symbol, exchange }) => ({ symbol, exchange }))).toEqual(expectedRequests);
      onQuote({ symbol: "VOD", exchange: "LSE" }, quote);
      return () => {};
    };
    const provider = new GloomberbCloudProvider();
    const quotes = await provider.getQuotesBatch(targets);
    expect(quotes[0]?.target).toBe(targets[1]!);
    expect(quotes[0]?.quote).toMatchObject({ symbol: "VOD:XLON", currency: "GBP", price: 1.18 });
    expect(quotes[1]?.target).toBe(targets[0]!);
    expect(quotes[1]?.quote).toMatchObject({ symbol: "VOD", currency: "USD", price: 15 });
    const financials = await provider.getTickerFinancialsBatch(targets);
    expect(financials[0]?.target).toBe(targets[1]!);
    expect(financials[0]?.financials?.quote?.symbol).toBe("VOD:XLON");
    const seen: string[] = [];
    const unsubscribe = provider.subscribeQuotes(targets, (target, streamed) => {
      expect(target).toBe(targets[1]!);
      expect(streamed.symbol).toBe("VOD:XLON");
      seen.push(target.symbol);
    });
    expect(seen).toEqual(["VOD:XLON"]);
    unsubscribe();
  });

  test("uses public delayed market routes anonymously but keeps research protected", async () => {
    let sessionChecks = 0;
    apiClient.ensureVerifiedSession = async () => {
      sessionChecks += 1;
      return null;
    };
    apiClient.getCloudQuote = async () => ({
      status: "success",
      data: {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 200,
        currency: "USD",
        change: 1,
        changePercent: 0.5,
        lastUpdated: Date.now(),
        dataSource: "delayed",
      },
    });
    apiClient.getCloudHistory = async () => ({
      status: "success",
      providerMeta: { provider: "yahoo" },
      data: [{ date: "2026-08-21", close: 200 }],
    });
    apiClient.getCloudOptionsChain = async () => ({
      status: "success",
      data: {
        providerId: "gloomberb-cloud",
        underlyingSymbol: "AAPL",
        expirationDates: [1_800_000_000],
        calls: [],
        puts: [],
        dataSource: "delayed",
        feed: "yahoo",
        delayMinutes: 15,
        realtimeEligible: false,
        asOf: "2026-08-21T20:00:00.000Z",
      },
    });
    apiClient.getCloudExchangeRate = async () => ({
      status: "success",
      data: { rate: 1.25 },
    });

    const provider = new GloomberbCloudProvider();
    expect(await provider.canProvide()).toBe(true);
    expect((await provider.getQuote("AAPL", "NASDAQ")).price).toBe(200);
    expect(await provider.getPriceHistory("AAPL", "NASDAQ", "1M")).toHaveLength(1);
    expect((await provider.getOptionsChain("AAPL", "NASDAQ")).feed).toBe("yahoo");
    expect(await provider.getExchangeRate("GBP")).toBe(1.25);
    expect(sessionChecks).toBe(0);

    await expect(provider.getAnalystResearch("AAPL", "NASDAQ")).rejects.toThrow(
      "requires signup and email verification",
    );
    expect(sessionChecks).toBe(1);
  });

  test("fetches detailed intraday chart history with cloud intervals", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string; params: Record<string, string | number | undefined> } | null } = { current: null };
    apiClient.getCloudHistory = async (symbol, exchange, params = {}) => {
      requestArgs.current = { symbol, exchange, params };
      return {
        status: "success",
        data: [{
          date: "2026-03-27 10:15:00",
          close: 250.12,
        }],
      };
    };

    const provider = new GloomberbCloudProvider();
    const history = await provider.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      new Date("2026-03-27T14:00:00Z"),
      new Date("2026-03-27T16:00:00Z"),
      "15m",
    );

    expect(requestArgs.current).toEqual({
      symbol: "AAPL",
      exchange: "NASDAQ",
      params: {
        interval: "15min",
        startDate: "2026-03-27 10:00:00",
        endDate: "2026-03-27 12:00:00",
      },
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.close).toBe(250.12);
    expect(history[0]?.date.toISOString()).toBe("2026-03-27T14:15:00.000Z");
  });

  test("rejects isolated cloud OHLC spikes so another history source can be used", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:46:00Z",
          open: 728.4,
          high: 728.7,
          low: 728.3,
          close: 728.5,
          volume: 0,
        },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        {
          date: "2026-07-29T20:48:00Z",
          open: 728.6,
          high: 728.7,
          low: 728.1,
          close: 728.3,
          volume: 0,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();

    await expect(
      provider.getPriceHistoryForResolution("SPY", "NYSEARCA", "1W", "1m"),
    ).rejects.toThrow("failed OHLC validation");
  });

  test("validates an outlier after normalizing descending cloud history", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:48:00Z",
          open: 728.6,
          high: 728.7,
          low: 728.1,
          close: 728.3,
          volume: 0,
        },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        {
          date: "2026-07-29T20:46:00Z",
          open: 728.4,
          high: 728.7,
          low: 728.3,
          close: 728.5,
          volume: 0,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();

    await expect(
      provider.getPriceHistoryForResolution("SPY", "NYSEARCA", "1W", "1m"),
    ).rejects.toThrow("failed OHLC validation");
  });

  test("preserves a wide cloud bar during a continuing price move", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      data: [
        {
          date: "2026-07-29T20:10:00Z",
          open: 561.1,
          high: 561.3,
          low: 560.7,
          close: 560.8994,
        },
        {
          date: "2026-07-29T20:15:00Z",
          open: 560.11,
          high: 585.61,
          low: 553.41,
          close: 555.4,
        },
        {
          date: "2026-07-29T20:20:00Z",
          open: 555.2,
          high: 556,
          low: 548.9,
          close: 549.01,
        },
      ],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution(
      "META",
      "NASDAQ",
      "1W",
      "5m",
    );

    expect(history).toHaveLength(3);
  });

  test("does not reject an explicitly Yahoo-backed cloud history response", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      providerMeta: { provider: "yahoo" },
      data: [
        { date: "2026-07-29T20:46:00Z", close: 728.5 },
        {
          date: "2026-07-29T20:47:00Z",
          open: 686.98,
          high: 728.67,
          low: 686.98,
          close: 728.6,
          volume: 0,
        },
        { date: "2026-07-29T20:48:00Z", close: 728.3 },
      ],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution(
      "SPY",
      "NYSEARCA",
      "1W",
      "1m",
    );

    expect(history[1]?.low).toBe(686.98);
  });

  test("normalizes daily detailed history requests to 1day", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: Record<string, string | number | undefined> | null } = { current: null };
    apiClient.getCloudHistory = async (_symbol, _exchange, params = {}) => {
      requestArgs.current = params;
      return {
        status: "success",
        data: [],
      };
    };

    const provider = new GloomberbCloudProvider();
    await provider.getDetailedPriceHistory(
      "AAPL",
      "NASDAQ",
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 2, 27, 0, 0, 0),
      "1d",
    );

    expect(requestArgs.current).toEqual({
      interval: "1day",
      startDate: "2026-01-01",
      endDate: "2026-03-27",
    });
  });

  test("monthly requests use calendar dates even near a US timezone boundary", async () => {
    const requests: Array<Record<string, string | number | undefined>> = [];
    apiClient.getCloudHistory = async (_symbol, _exchange, params = {}) => {
      requests.push(params);
      return { status: "success", data: [{ date: "2026-08-01", close: 710 }] };
    };
    const provider = new GloomberbCloudProvider();
    const rows = await provider.getDetailedPriceHistory("QQQ", "NASDAQ", new Date("2026-01-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"), "1mo");
    expect(requests[0]).toEqual({ interval: "1month", startDate: "2026-01-01", endDate: "2026-09-01" });
    expect(rows[0]?.close).toBe(710);
    await provider.getPriceHistoryForResolution("QQQ", "NASDAQ", "ALL", "1mo");
    expect(requests[1]?.interval).toBe("1month");
    expect(requests[1]?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(requests[1]?.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("fetches fixed-resolution chart history with the requested interval", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: Record<string, string | number | undefined> | null } = { current: null };
    apiClient.getCloudHistory = async (_symbol, _exchange, params = {}) => {
      requestArgs.current = params;
      return {
        status: "success",
        data: [{
          date: "2026-03-27",
          close: 250.12,
        }],
      };
    };

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistoryForResolution("AAPL", "NASDAQ", "1Y", "1wk");

    expect(requestArgs.current?.interval).toBe("1week");
    expect(requestArgs.current?.startDate).toBeDefined();
    expect(requestArgs.current?.endDate).toBeDefined();
    expect(history[0]?.close).toBe(250.12);
  });

  test("does not advertise unsupported 45 minute chart resolution", () => {
    const provider = new GloomberbCloudProvider();
    expect(provider.getChartResolutionCapabilities()).not.toContain("45m");
    expect(provider.getChartResolutionSupport()).toContainEqual({
      resolution: "1d",
      maxRange: "5Y",
    });
    expect(provider.getChartResolutionSupport()).toContainEqual({
      resolution: "1wk",
      maxRange: "5Y",
    });
  });

  test("normalizes sub-unit cloud quotes to their main currency", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudQuote = async () => ({
      status: "success",
      data: {
        symbol: "IQE",
        providerId: "gloomberb-cloud",
        price: 23.1,
        currency: "GBp",
        change: -1.4,
        changePercent: -5.71,
        previousClose: 24.5,
        lastUpdated: Date.now(),
        dataSource: "delayed",
      },
    });

    const provider = new GloomberbCloudProvider();
    const quote = await provider.getQuote("IQE", "LSE");

    expect(quote.currency).toBe("GBP");
    expect(quote.price).toBeCloseTo(0.231, 8);
    expect(quote.change).toBeCloseTo(-0.014, 8);
    expect(quote.previousClose).toBeCloseTo(0.245, 8);
  });

  test("normalizes sub-unit cloud history using the response currency metadata", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;
    apiClient.getCloudHistory = async () => ({
      status: "success",
      providerMeta: {
        currency: "GBp",
      },
      data: [{
        date: "2026-03-27 10:15:00",
        open: 22.55,
        high: 23.4,
        low: 22.1,
        close: 23.1,
      }],
    });

    const provider = new GloomberbCloudProvider();
    const history = await provider.getPriceHistory("IQE", "LSE", "1Y");

    expect(history[0]?.open).toBeCloseTo(0.2255, 8);
    expect(history[0]?.high).toBeCloseTo(0.234, 8);
    expect(history[0]?.low).toBeCloseTo(0.221, 8);
    expect(history[0]?.close).toBeCloseTo(0.231, 8);
  });

  test("preserves normalized LSE cloud history when currency metadata is missing or uses a major unit", async () => {
    const provider = new GloomberbCloudProvider();
    for (const currency of [undefined, "GBP", "USD"]) {
      apiClient.getCloudHistory = async () => ({
        status: "success",
        ...(currency ? { currency } : {}),
        data: [{ date: "2026-08-31T00:00:00.000Z", open: 1.241, high: 1.285, low: 1.198, close: 1.256, volume: 123 }],
      });
      const history = await provider.getPriceHistory("VOD:XLON", "LSE", "ALL");
      expect(history[0]).toMatchObject({ open: 1.241, high: 1.285, low: 1.198, close: 1.256, volume: 123 });
    }
  });

  test("fetches institutional holders from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudHolders = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          asOf: "2026-03-31",
          holders: [{
            providerId: "gloomberb-cloud",
            ownerType: "institution",
            name: "Vanguard Group Inc",
            reportDate: "2026-03-31",
            shares: 1_250_000_000,
            value: 250_000_000_000,
            percentHeld: 0.085,
          }],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const holders = await provider.getHolders("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(holders.providerId).toBe("gloomberb-cloud");
    expect(holders.holders[0]?.name).toBe("Vanguard Group Inc");
    expect(holders.holders[0]?.percentHeld).toBe(0.085);
  });

  test("fetches analyst research from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudAnalystResearch = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          priceTarget: { average: 300, current: 270, currency: "USD" },
          recommendationRating: 8.2,
          recommendations: [{ period: "current month", strongBuy: 7, buy: 24, hold: 14, sell: 1, strongSell: 1 }],
          ratings: [{ date: "2026-04-17", firm: "BNP Paribas", action: "Upgrade", current: "Outperform", prior: "Neutral" }],
          earningsEstimates: [],
          revenueEstimates: [],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const research = await provider.getAnalystResearch("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(research.priceTarget?.average).toBe(300);
    expect(research.ratings[0]?.firm).toBe("BNP Paribas");
  });

  test("fetches corporate actions from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange: string } | null } = { current: null };
    apiClient.getCloudCorporateActions = async (symbol, exchange) => {
      requestArgs.current = { symbol, exchange: exchange ?? "" };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          symbol: "AAPL",
          currency: "USD",
          exchange: "NASDAQ",
          dividends: [{ exDate: "2026-02-09", amount: 0.26 }],
          splits: [],
          earnings: [{ date: "2026-01-29", epsEstimate: 2.67, epsActual: 2.84, difference: 0.17, surprisePercent: 6.37 }],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const actions = await provider.getCorporateActions("AAPL", "NASDAQ");

    expect(requestArgs.current).toEqual({ symbol: "AAPL", exchange: "NASDAQ" });
    expect(actions.dividends[0]?.amount).toBe(0.26);
    expect(actions.earnings[0]?.surprisePercent).toBe(6.37);
  });

  test("fetches options chains from the cloud market endpoint", async () => {
    apiClient.ensureVerifiedSession = async () => verifiedUser;

    const requestArgs: { current: { symbol: string; exchange?: string; expirationDate?: number } | null } = { current: null };
    apiClient.getCloudOptionsChain = async (symbol, exchange, expirationDate) => {
      requestArgs.current = { symbol, exchange, expirationDate };
      return {
        status: "success",
        data: {
          providerId: "gloomberb-cloud",
          underlyingSymbol: "AMD",
          expirationDates: [1_800_000_000],
          dataSource: "live",
          feed: "opra",
          delayMinutes: 0,
          realtimeEligible: true,
          asOf: "2027-01-15T14:30:00.000Z",
          calls: [{
            contractSymbol: "AMD270917C00230000",
            strike: 230,
            currency: "USD",
            lastPrice: 11,
            change: 1,
            percentChange: 10,
            volume: 10,
            openInterest: 20,
            bid: 10,
            ask: 12,
            impliedVolatility: 0.4,
            inTheMoney: false,
            expiration: 1_800_000_000,
            lastTradeDate: 1_799_000_000,
          }],
          puts: [],
        },
      };
    };

    const provider = new GloomberbCloudProvider();
    const chain = await provider.getOptionsChain("AMD", "NASDAQ", 1_800_000_000);

    expect(requestArgs.current).toEqual({
      symbol: "AMD",
      exchange: "NASDAQ",
      expirationDate: 1_800_000_000,
    });
    expect(chain.underlyingSymbol).toBe("AMD");
    expect(chain.calls[0]?.contractSymbol).toBe("AMD270917C00230000");
    expect(chain).toMatchObject({
      providerId: "gloomberb-cloud",
      dataSource: "live",
      feed: "opra",
      delayMinutes: 0,
      realtimeEligible: true,
      asOf: "2027-01-15T14:30:00.000Z",
    });
  });

  test("preserves original target context when streaming quotes", () => {
    let unsubscribeCalled = false;
    const seenQuotes: Array<{ price: number; currency: string }> = [];
    apiClient.subscribeQuotes = (_targets, onQuote) => {
      onQuote(
        { symbol: "AAPL", exchange: "NASDAQ" },
        {
          symbol: "AAPL",
          providerId: "gloomberb-cloud",
          price: 23.1,
          currency: "GBp",
          change: -1.4,
          changePercent: 0.5,
          lastUpdated: Date.now(),
          dataSource: "live",
        },
      );
      return () => {
        unsubscribeCalled = true;
      };
    };

    const provider = new GloomberbCloudProvider();
    const seenTargets: Array<{ brokerId?: string; brokerInstanceId?: string }> = [];
    const unsubscribe = provider.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
      },
    }], (target, quote) => {
      seenTargets.push({
        brokerId: target.context?.brokerId,
        brokerInstanceId: target.context?.brokerInstanceId,
      });
      seenQuotes.push({
        price: quote.price,
        currency: quote.currency,
      });
    });

    expect(seenTargets).toEqual([{
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
    }]);
    expect(seenQuotes).toEqual([{
      price: 0.231,
      currency: "GBP",
    }]);

    unsubscribe();
    expect(unsubscribeCalled).toBe(true);
  });

  test("maps news ticker labels from validated story links only", async () => {
    apiClient.getCloudNews = async () => ({
      items: [{
        id: "story-1",
        headline: "Sanofi reports vaccine update",
        summary: "Sanofi and Moderna shared new vaccine data.",
        topic: "product_approval",
        topics: ["product_approval"],
        category: "product_approval",
        sentiment: "positive",
        sectors: ["health_care"],
        firstPublishedAt: "2026-04-01T10:00:00.000Z",
        lastPublishedAt: "2026-04-01T10:05:00.000Z",
        firstSeenAt: "2026-04-01T10:00:10.000Z",
        lastSeenAt: "2026-04-01T10:05:10.000Z",
        primaryUrl: "https://example.com/sny-vaccine",
        primarySource: "example-wire",
        scores: {
          importance: 77,
          urgency: 66,
          marketImpact: 82,
          novelty: 71,
          confidence: 93,
        },
        flags: {
          breaking: false,
          developing: false,
          stale: false,
        },
        variantCount: 1,
        sourceCount: 1,
        sources: ["example-wire"],
        entities: [{
          id: "entity-1",
          entityType: "company",
          name: "Sanofi",
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          role: null,
          confidence: 0.95,
        }, {
          id: "entity-2",
          entityType: "company",
          name: "Noise Corp",
          symbol: "NOISE",
          exchange: "OTC",
          canonicalTicker: "NOISE:OTC",
          role: null,
          confidence: 0.6,
        }],
        tickerLinks: [{
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          relationType: "direct",
          displayTier: "primary",
          confidence: 0.98,
          relevanceScore: 95,
          impactScore: 88,
          sentiment: "positive",
        }, {
          symbol: "SNY",
          exchange: "NASDAQ",
          canonicalTicker: "SNY:NASDAQ",
          relationType: "direct",
          displayTier: "primary",
          confidence: 0.98,
          relevanceScore: 95,
          impactScore: 88,
          sentiment: "positive",
        }, {
          symbol: "MRNA",
          exchange: "NASDAQ",
          canonicalTicker: "MRNA:NASDAQ",
          relationType: "competitor",
          displayTier: "related",
          confidence: 0.8,
          relevanceScore: 65,
          impactScore: 54,
          sentiment: "neutral",
        }],
      }],
      nextCursor: null,
    });

    const source = createGloomberbCloudCapabilities().find((capability) => capability.kind === "news") as NewsCapability;
    const news = await source.provider.fetchNews({ feed: "top", ticker: "SNY" });

    expect(news[0]?.tickers).toEqual(["SNY", "MRNA"]);
    expect(news[0]?.importance).toBe(77);
    expect(news[0]?.scores).toEqual({
      importance: 77,
      urgency: 66,
      marketImpact: 82,
      novelty: 71,
      confidence: 93,
    });
  });

  test("fetches story detail with ordered source items", async () => {
    let requestedStoryId = "";
    apiClient.getCloudNewsStory = async (storyId) => {
      requestedStoryId = storyId;
      return makeCloudNewsPayload({
        id: storyId,
        items: [{
          id: "item-2",
          sourceKey: "wire-b",
          sourceName: "Wire B",
          title: "Follow-up",
          summary: "More details emerged.",
          url: "https://example.com/follow-up",
          publishedAt: "2026-04-01T10:05:00.000Z",
          hasArticleText: true,
        }, {
          id: "item-1",
          sourceKey: "wire-a",
          sourceName: "Wire A",
          title: "Original",
          summary: "The first report.",
          url: "https://example.com/original",
          publishedAt: "2026-04-01T10:00:00.000Z",
          hasArticleText: false,
        }],
      });
    };

    const source = createGloomberbCloudCapabilities().find((capability) => capability.kind === "news") as NewsCapability;
    const story = await source.provider.fetchNewsStory?.("story-1");

    expect(requestedStoryId).toBe("story-1");
    expect(story?.items?.map((item) => item.id)).toEqual(["item-2", "item-1"]);
    expect(story?.items?.[0]?.publishedAt).toEqual(new Date("2026-04-01T10:05:00.000Z"));
  });
});

test("cloud SEC acceptance keeps timezone-free source values without using the machine timezone", async () => {
  apiClient.ensureVerifiedSession = async () => verifiedUser;
  const values = ["2025-03-20T20:10:11.000Z", "2025-03-20T16:10:11", "20250320161011"];
  apiClient.getCloudSecFilings = async () => ({ filings: values.map((acceptedAt, index) => ({
    accessionNumber: String(index), form: "8-K", filingDate: "2025-03-20", acceptedAt,
    cik: "0001048911", filingUrl: "https://www.sec.gov/filing",
  })) });
  const rows = await new GloomberbCloudProvider().getSecFilings("FDX");
  expect(rows.map((row) => row.acceptedAtRaw)).toEqual(values);
  expect(rows.map((row) => row.acceptedAt?.toISOString())).toEqual([values[0], undefined, undefined]);
});
