import { useRegularMarketSession } from "../../test-support/market-session";
import { afterEach, describe, expect, test } from "bun:test";
import { CloudApiRequestTransport } from "../../api-client/request";
import { AppPersistence } from "../../data/app-persistence";
import { AssetDataRouter } from "./index";
import { getRouterEntityKey } from "./cache";
import { assetDataProvider } from "../../capabilities";
import type { BrokerAdapter } from "../../types/broker";
import type { DataProvider, QuoteSubscriptionTarget } from "../../types/data-provider";
import type { CapabilityRouteSource } from "../../types/capability-route-source";
import {
  attachTestRegistry,
  brokerInstance,
  cleanupProviderRouterTestFiles,
  createBrokerConfig,
  createTempDbPath,
  fallbackProvider,
  makeArticle,
  makeFinancials,
  makeQuote,
  setBrokerInstances,
} from "./test-support";

useRegularMarketSession();

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
  cleanupProviderRouterTestFiles();
});

describe("AssetDataRouter", () => {
  test("falls through to Yahoo quotes and history when Cloud market requests never settle", async () => {
    const cloudCalls = { quote: 0, history: 0 };
    const yahooCalls = { quote: 0, history: 0 };
    const cloudTransport = new CloudApiRequestTransport({
      marketRequestTimeoutMs: 10,
      fetchTransport: async () => new Promise<Response>(() => {}),
    });
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      priority: 100,
      async getQuote() {
        cloudCalls.quote += 1;
        await cloudTransport.request("/market/quote?symbol=AAPL");
        throw new Error("unreachable");
      },
      async getPriceHistory() {
        cloudCalls.history += 1;
        await cloudTransport.request("/market/history?symbol=AAPL&range=1Y");
        throw new Error("unreachable");
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getQuote() {
        yahooCalls.quote += 1;
        return makeQuote({ providerId: "yahoo", price: 212.5 });
      },
      async getPriceHistory() {
        yahooCalls.history += 1;
        return [
          { date: new Date("2026-07-10T00:00:00Z"), close: 210 },
          { date: new Date("2026-07-11T00:00:00Z"), close: 212.5 },
        ];
      },
    };
    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    console.error = () => {};

    const quote = await router.getQuote("AAPL", "NASDAQ");
    const history = await router.getPriceHistory("AAPL", "NASDAQ", "1Y");

    expect(quote.providerId).toBe("yahoo");
    expect(quote.price).toBe(212.5);
    expect(history.map((point) => point.close)).toEqual([210, 212.5]);
    expect(cloudCalls).toEqual({ quote: 1, history: 1 });
    expect(yahooCalls).toEqual({ quote: 1, history: 1 });
  });

  test("routes market calls only through sources with market capability", async () => {
    const newsOnlySource: CapabilityRouteSource = {
      id: "news-only",
      name: "News Only",
      priority: 1,
      news: {
        fetchNews: async () => {
          throw new Error("news-only source should not handle market requests");
        },
      },
    };
    const marketSource: CapabilityRouteSource = {
      id: "market-source",
      name: "Market Source",
      priority: 10,
      market: {
        ...fallbackProvider,
        id: "market-source",
        name: "Market Source",
        async getQuote(symbol) {
          return {
            symbol,
            providerId: "market-source",
            price: 250,
            currency: "USD",
            change: 1,
            changePercent: 0.4,
            lastUpdated: Date.now(),
          };
        },
      },
    };

    const router = new AssetDataRouter(fallbackProvider, [newsOnlySource, marketSource]);

    const quote = await router.getQuote("AAPL", "NASDAQ");

    expect(quote.providerId).toBe("market-source");
    expect(quote.price).toBe(250);
  });

  test("routes news calls only through sources with news capability", async () => {
    const article = makeArticle("source-news");
    const marketOnlySource: CapabilityRouteSource = {
      id: "market-only",
      name: "Market Only",
      priority: 1,
      market: {
        ...fallbackProvider,
        id: "market-only",
        name: "Market Only",
      },
    };
    const newsSource: CapabilityRouteSource = {
      id: "news-source",
      name: "News Source",
      priority: 10,
      news: {
        fetchNews: async () => [article],
      },
    };
    const router = new AssetDataRouter(null, [marketOnlySource, newsSource]);

    const articles = await router.getNews({ feed: "latest", limit: 10 });

    expect(articles).toEqual([article]);
  });

  test("falls back to later providers when holder data is empty", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getHolders(symbol) {
        return {
          providerId: "cloud",
          symbol,
          holders: [],
        };
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getHolders(symbol) {
        return {
          providerId: "yahoo",
          symbol,
          currency: "USD",
          holders: [{
            providerId: "yahoo",
            ownerType: "institution",
            name: "Vanguard Group Inc",
            shares: 1_200_000_000,
            value: 250_000_000_000,
            percentHeld: 0.08,
            changePercent: 0.02,
          }],
        };
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const holders = await router.getHolders("AAPL", "NASDAQ");

    expect(holders.providerId).toBe("yahoo");
    expect(holders.holders[0]?.name).toBe("Vanguard Group Inc");
  });

  test("routes earnings calendars through providers and fills missing symbols from fallback", async () => {
    const cloudCalls: string[][] = [];
    const yahooCalls: string[][] = [];
    const event = (symbol: string, date: string) => ({
      symbol,
      name: symbol,
      earningsDate: new Date(date),
      epsEstimate: null,
      epsActual: null,
      revenueEstimate: null,
      revenueActual: null,
      surprise: null,
      timing: "" as const,
    });
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getEarningsCalendar(symbols) {
        cloudCalls.push(symbols);
        return [event("AAPL", "2026-07-30T20:00:00Z")];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getEarningsCalendar(symbols) {
        yahooCalls.push(symbols);
        return [event("MSFT", "2026-07-29T20:00:00Z")];
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const events = await router.getEarningsCalendar(["msft", " AAPL ", "aapl"]);

    expect(cloudCalls).toEqual([["MSFT", "AAPL"]]);
    expect(yahooCalls).toEqual([["MSFT"]]);
    expect(events.map((entry) => entry.symbol)).toEqual(["MSFT", "AAPL"]);
  });

  test("falls back to later analyst providers when rating targets are missing", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getAnalystResearch(symbol) {
        return {
          providerId: "cloud",
          symbol,
          ratings: [{ date: "2026-05-01", firm: "Cloud Firm", action: "Raises", current: "Buy", prior: "Buy" }],
          recommendations: [],
          earningsEstimates: [],
          revenueEstimates: [],
        };
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getAnalystResearch(symbol) {
        return {
          providerId: "yahoo",
          symbol,
          ratings: [{
            date: "2026-05-01",
            firm: "Yahoo Firm",
            action: "Raises",
            current: "Buy",
            prior: "Buy",
            currentPriceTarget: 680,
            priorPriceTarget: 595,
          }],
          recommendations: [],
          earningsEstimates: [],
          revenueEstimates: [],
        };
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const research = await router.getAnalystResearch("AAPL", "NASDAQ");

    expect(research.providerId).toBe("yahoo");
    expect(research.ratings[0]?.currentPriceTarget).toBe(680);
    expect(research.ratings[0]?.priorPriceTarget).toBe(595);
  });

  test("prefers cached analyst records with rating targets", async () => {
    const dbPath = createTempDbPath("cached-analyst-targets");
    const persistence = new AppPersistence(dbPath);
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getAnalystResearch(symbol) {
        return {
          providerId: "cloud",
          symbol,
          ratings: [{ date: "2026-05-01", firm: "Cloud Firm", action: "Raises", current: "Buy", prior: "Buy" }],
          recommendations: [],
          earningsEstimates: [],
          revenueEstimates: [],
        };
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getAnalystResearch(symbol) {
        return {
          providerId: "yahoo",
          symbol,
          ratings: [{
            date: "2026-05-01",
            firm: "Yahoo Firm",
            action: "Raises",
            current: "Buy",
            prior: "Buy",
            currentPriceTarget: 680,
            priorPriceTarget: 595,
          }],
          recommendations: [],
          earningsEstimates: [],
          revenueEstimates: [],
        };
      },
    };
    const unavailableProvider = (id: string, priority: number): DataProvider => ({
      ...fallbackProvider,
      id,
      name: id,
      priority,
      async getAnalystResearch() {
        throw new Error(`${id} should not be fetched`);
      },
    });

    try {
      const seedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
      await seedRouter.getAnalystResearch("AAPL", "NASDAQ");

      const cachedRouter = new AssetDataRouter(
        unavailableProvider("yahoo", 1000),
        [unavailableProvider("cloud", 100)],
        persistence.resources,
      );
      const research = await cachedRouter.getAnalystResearch("AAPL", "NASDAQ");

      expect(research.providerId).toBe("yahoo");
      expect(research.ratings[0]?.currentPriceTarget).toBe(680);
      expect(research.ratings[0]?.priorPriceTarget).toBe(595);
    } finally {
      persistence.close();
    }
  });

  test("prefers broker quotes over fallback quotes", async () => {
    const router = new AssetDataRouter(fallbackProvider);
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getQuote() {
        return {
          symbol: "AAPL",
          price: 123.45,
          currency: "USD",
          change: 1,
          changePercent: 0.8,
          lastUpdated: Date.now(),
        };
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [
      brokerInstance({
        config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
      }),
    ]);

    const quote = await router.getQuote("AAPL", "NASDAQ", { brokerId: "ibkr", brokerInstanceId: "ibkr-work" });
    expect(quote.price).toBe(123.45);
  });

  test("reconciles broker quote price with provider day reference fields", async () => {
    const router = new AssetDataRouter({
      ...fallbackProvider,
      id: "yahoo",
      async getQuote() {
        return {
          symbol: "VICR",
          providerId: "yahoo",
          price: 299.74,
          currency: "USD",
          previousClose: 282.95,
          change: 16.79,
          changePercent: 5.93,
          lastUpdated: Date.now(),
        };
      },
    });
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getQuote() {
        return {
          symbol: "VICR",
          providerId: "ibkr",
          price: 299.8,
          currency: "USD",
          previousClose: 380.1,
          change: -80.3,
          changePercent: -21.12,
          lastUpdated: Date.now(),
          dataSource: "live",
        };
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const quote = await router.getQuote("VICR", "NASDAQ", { brokerId: "ibkr", brokerInstanceId: "ibkr-work" });
    expect(quote.providerId).toBe("ibkr");
    expect(quote.price).toBe(299.8);
    expect(quote.previousClose).toBe(282.95);
    expect(quote.change).toBeCloseTo(16.85, 5);
    expect(quote.changePercent).toBeCloseTo(5.955, 3);
    expect(quote.provenance?.price?.providerId).toBe("ibkr");
    expect(quote.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
  });

  test("refreshes broker option session references across the market close", async () => {
    const dbPath = createTempDbPath("option-session-transition");
    const persistence = new AppPersistence(dbPath);
    const optionSymbol = "IBIT  281215C00030000";
    const context = {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
        symbol: "IBIT",
        localSymbol: optionSymbol,
        secType: "OPT",
      },
    } as const;
    const entityKey = getRouterEntityKey(optionSymbol, context.instrument);
    const providerSourceKey = "provider:yahoo";
    const cacheKey = {
      namespace: "market",
      kind: "quote",
      entityKey,
      variantKey: "",
      sourceKey: providerSourceKey,
    };
    const regularReference = makeQuote({
      symbol: optionSymbol,
      providerId: "yahoo",
      price: 15.775,
      change: 0.29,
      changePercent: 1.87,
      previousClose: 15.485,
      listingExchangeName: "OPTIONS",
      marketState: "REGULAR",
      sessionConfidence: "derived",
    });
    let providerCalls = 0;
    let providerAvailable = true;
    const provider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async getQuote() {
        providerCalls += 1;
        if (!providerAvailable) throw new Error("temporary provider outage");
        return {
          ...regularReference,
          marketState: "CLOSED",
          lastUpdated: Date.now(),
        };
      },
    };
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getQuote() {
        return {
          ...regularReference,
          providerId: "ibkr",
          previousClose: 99,
          marketState: undefined,
          sessionConfidence: "unknown",
          dataSource: "live",
          lastUpdated: Date.now(),
        };
      },
    };

    try {
      persistence.resources.set(cacheKey, regularReference, {
        cachePolicy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
        fetchedAt: Date.now() - 2 * 60_000,
      });
      const router = new AssetDataRouter(provider, [], persistence.resources);
      attachTestRegistry(router, { brokers: [["ibkr", broker]] });
      setBrokerInstances(router, [brokerInstance()]);

      const staleTransition = await router.getQuote(optionSymbol, "", context);
      expect(staleTransition.marketState).toBe("CLOSED");
      expect(providerCalls).toBe(1);

      persistence.resources.set(cacheKey, regularReference, {
        cachePolicy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
        fetchedAt: Date.now(),
      });
      const forcedTransition = await router.getQuote(optionSymbol, "", {
        ...context,
        cacheMode: "refresh",
      });
      expect(forcedTransition.marketState).toBe("CLOSED");
      expect(providerCalls).toBe(2);

      providerAvailable = false;
      persistence.resources.set(cacheKey, regularReference, {
        cachePolicy: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
        fetchedAt: Date.now() - 2 * 60_000,
      });
      const outageFallback = await router.getQuote(optionSymbol, "", context);
      expect(outageFallback.previousClose).toBe(15.485);
      expect(outageFallback.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
      expect(outageFallback.marketState).toBeUndefined();
      expect(providerCalls).toBe(3);
    } finally {
      persistence.close();
    }
  });

  test("prefers broker options chains for broker-context targets", async () => {
    const chain = {
      underlyingSymbol: "AAPL",
      expirationDates: [1_800_000_000],
      calls: [],
      puts: [],
    };
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getOptionsChain(ticker, _instance, exchange, expirationDate) {
        expect(ticker).toBe("AAPL");
        expect(exchange).toBe("NASDAQ");
        expect(expirationDate).toBe(1_800_000_000);
        return chain;
      },
    };
    const fallback: DataProvider = {
      ...fallbackProvider,
      async getOptionsChain() {
        throw new Error("fallback should not handle broker-context options");
      },
    };
    const router = new AssetDataRouter(fallback);
    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const result = await router.getOptionsChain("AAPL", "NASDAQ", 1_800_000_000, {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });

    expect(result).toBe(chain);
  });

  test("falls back to provider quotes when a broker mark is stale", async () => {
    const fixedNow = Date.parse("2026-05-13T21:00:00Z");
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const yahooProvider: DataProvider = {
        ...fallbackProvider,
        id: "yahoo",
        name: "Yahoo",
        async getQuote(symbol) {
          return {
            symbol,
            providerId: "yahoo",
            price: 50_500,
            currency: "JPY",
            change: 4400,
            changePercent: 9.54,
            lastUpdated: Date.parse("2026-05-13T06:24:00Z"),
            listingExchangeName: "JPX",
            marketState: "CLOSED",
            dataSource: "delayed",
          };
        },
      };
      const router = new AssetDataRouter(yahooProvider);
      const broker: BrokerAdapter = {
        id: "ibkr",
        name: "IBKR",
        configSchema: [],
        async validate() {
          return true;
        },
        async importPositions() {
          return [];
        },
        async getQuote() {
          return {
            symbol: "285A.T",
            providerId: "ibkr",
            price: 46_100,
            currency: "JPY",
            change: 0,
            changePercent: 0,
            lastUpdated: Date.parse("2026-05-08T06:00:00Z"),
            dataSource: "delayed",
          };
        },
      };

      attachTestRegistry(router, { brokers: [["ibkr", broker]] });
      setBrokerInstances(router, [
        brokerInstance({
          config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
        }),
      ]);

      const quote = await router.getQuote("285A.T", "TSEJ", { brokerId: "ibkr", brokerInstanceId: "ibkr-work" });
      expect(quote.providerId).toBe("yahoo");
      expect(quote.price).toBe(50_500);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("prefers the requested broker instance in search results", async () => {
    const router = new AssetDataRouter(fallbackProvider);
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async searchInstruments(_query, instance) {
        return [{
          providerId: "ibkr",
          symbol: instance.label === "Work" ? "AAPL" : "MSFT",
          name: `${instance.label} contract`,
          exchange: "NASDAQ",
          type: "STK",
          brokerContract: {
            brokerId: "ibkr",
            symbol: instance.label === "Work" ? "AAPL" : "MSFT",
            exchange: "SMART",
          },
        }];
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [
      brokerInstance({
        config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
      }),
      brokerInstance({
        id: "ibkr-personal",
        label: "Personal",
        config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4003, clientId: 2 } },
      }),
    ]);

    const results = await router.search("AAPL", { preferBroker: true, brokerInstanceId: "ibkr-work" });
    expect(results[0]?.brokerInstanceId).toBe("ibkr-work");
    expect(results[0]?.brokerLabel).toBe("Work");
    expect(results[0]?.brokerContract?.brokerInstanceId).toBe("ibkr-work");
  });

  test("keeps the richer search result when providers return the same instrument", async () => {
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async searchInstruments() {
        return [{
          providerId: "ibkr",
          symbol: "AAPL",
          name: "Apple Inc",
          exchange: "NASDAQ",
          type: "STK",
          brokerLabel: "Work",
          brokerContract: {
            brokerId: "ibkr",
            brokerInstanceId: "ibkr-work",
            symbol: "AAPL",
            localSymbol: "AAPL",
            exchange: "SMART",
          },
        }];
      },
    };
    const provider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      async search() {
        return [{
          providerId: "yahoo",
          symbol: "AAPL",
          name: "Apple",
          exchange: "NASDAQ",
          type: "STK",
        }];
      },
    };
    const router = new AssetDataRouter(fallbackProvider, [provider]);

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [
      brokerInstance({
        config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
      }),
    ]);

    const results = await router.search("AAPL", { preferBroker: true, brokerInstanceId: "ibkr-work" });
    expect(results).toHaveLength(1);
    expect(results[0]?.providerId).toBe("ibkr");
    expect(results[0]?.brokerContract?.localSymbol).toBe("AAPL");
  });

  test("does not search fallback providers when the preferred provider returns results", async () => {
    let cloudCalls = 0;
    let yahooCalls = 0;
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async search() {
        cloudCalls += 1;
        return [{ providerId: "cloud", symbol: "SEC0", name: "iShares ETF", exchange: "XETRA", type: "ETF" }];
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async search() {
        yahooCalls += 1;
        return [{ providerId: "yahoo", symbol: "SEC0", name: "iShares ETF", exchange: "XETRA", type: "ETF" }];
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const results = await router.search("SEC0");

    expect(results[0]?.providerId).toBe("cloud");
    expect(cloudCalls).toBe(1);
    expect(yahooCalls).toBe(0);
  });

  test("routes through registered asset-data capabilities", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 10,
      async getQuote() {
        return {
          symbol: "AAPL",
          providerId: "cloud",
          price: 125,
          currency: "USD",
          change: 1,
          changePercent: 0.8,
          lastUpdated: Date.now(),
        };
      },
    };
    const router = new AssetDataRouter(fallbackProvider);
    attachTestRegistry(router, {
      getEnabledCapabilities: (kind?: string) => (
        kind === "asset-data" ? [assetDataProvider(cloudProvider)] : []
      ),
    });

    const quote = await router.getQuote("AAPL", "NASDAQ");
    expect(quote.price).toBe(125);
    expect(quote.providerId).toBe("cloud");
  });

  test("falls back when the preferred provider returns a stale quote", async () => {
    const fixedNow = Date.parse("2026-05-13T21:00:00Z");
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const yahooProvider: DataProvider = {
        ...fallbackProvider,
        id: "yahoo",
        name: "Yahoo",
        async getQuote(symbol) {
          return {
            symbol,
            providerId: "yahoo",
            price: 168,
            currency: "TWD",
            change: 1,
            changePercent: 0.6,
            lastUpdated: Date.parse("2026-05-13T05:30:00Z"),
            listingExchangeName: "TWSE",
            marketState: "CLOSED",
            dataSource: "delayed",
          };
        },
      };
      const cloudProvider: DataProvider = {
        ...fallbackProvider,
        id: "gloomberb-cloud",
        name: "Cloud",
        priority: 100,
        async getQuote(symbol) {
          return {
            symbol,
            providerId: "gloomberb-cloud",
            price: 150,
            currency: "TWD",
            change: 0,
            changePercent: 0,
            lastUpdated: Date.parse("2026-05-08T06:00:00Z"),
            listingExchangeName: "TWSE",
            marketState: "CLOSED",
            dataSource: "delayed",
          };
        },
        async getQuotesBatch(targets) {
          return targets.map((target) => ({
            target,
            quote: {
              symbol: target.symbol,
              providerId: "gloomberb-cloud",
              price: 150,
              currency: "TWD",
              change: 0,
              changePercent: 0,
              lastUpdated: Date.parse("2026-05-08T06:00:00Z"),
              listingExchangeName: "TWSE",
              marketState: "CLOSED",
              dataSource: "delayed",
            },
          }));
        },
      };
      const router = new AssetDataRouter(yahooProvider, [cloudProvider]);

      const quote = await router.getQuote("2337", "TWSE");
      expect(quote.providerId).toBe("yahoo");
      expect(quote.price).toBe(168);

      const [batch] = await router.getQuotesBatch([{ symbol: "2337", exchange: "TWSE" }], { forceRefresh: true });
      expect(batch?.quote?.providerId).toBe("yahoo");
      expect(batch?.quote?.price).toBe(168);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("prefers provider quote streams when one is available", () => {
    const brokerTargets: QuoteSubscriptionTarget[] = [];
    const providerTargets: QuoteSubscriptionTarget[] = [];
    let brokerUnsubscribed = 0;
    let providerUnsubscribed = 0;

    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      subscribeQuotes(_instance, targets, onQuote) {
        brokerTargets.push(...targets);
        onQuote(targets[0]!, {
          symbol: "AAPL",
          price: 123.45,
          currency: "USD",
          change: 1,
          changePercent: 0.8,
          lastUpdated: Date.now(),
        });
        return () => {
          brokerUnsubscribed += 1;
        };
      },
    };
    const streamingProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      subscribeQuotes(targets, onQuote) {
        providerTargets.push(...targets);
        onQuote(targets[0]!, {
          symbol: targets[0]!.symbol,
          price: 456.78,
          currency: "USD",
          change: 2,
          changePercent: 0.4,
          lastUpdated: Date.now(),
        });
        return () => {
          providerUnsubscribed += 1;
        };
      },
    };

    const router = new AssetDataRouter(fallbackProvider, [streamingProvider]);
    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const seenSymbols: string[] = [];
    const unsubscribe = router.subscribeQuotes([
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        context: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-work",
        },
      },
      {
        symbol: "MSFT",
        exchange: "NASDAQ",
      },
    ], (target) => {
      seenSymbols.push(target.symbol);
    });

    expect(brokerTargets).toEqual([]);
    expect(providerTargets).toEqual([
      {
        symbol: "AAPL",
        exchange: "NASDAQ",
        context: {
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-work",
        },
      },
      {
        symbol: "MSFT",
        exchange: "NASDAQ",
      },
    ]);
    expect(seenSymbols).toEqual(["AAPL"]);

    unsubscribe();
    expect(brokerUnsubscribed).toBe(0);
    expect(providerUnsubscribed).toBe(1);
  });

  test("can force broker-linked targets onto provider streaming", () => {
    const brokerTargets: QuoteSubscriptionTarget[] = [];
    const providerTargets: QuoteSubscriptionTarget[] = [];

    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      subscribeQuotes(_instance, targets) {
        brokerTargets.push(...targets);
        return () => {};
      },
    };
    const streamingProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      subscribeQuotes(targets) {
        providerTargets.push(...targets);
        return () => {};
      },
    };

    const router = new AssetDataRouter(fallbackProvider, [streamingProvider]);
    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const unsubscribe = router.subscribeQuotes([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      route: "provider",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
      },
    }], () => {});

    expect(brokerTargets).toEqual([]);
    expect(providerTargets).toEqual([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      route: "provider",
      context: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-work",
      },
    }]);

    unsubscribe();
  });

  test("drops empty zero provider stream quotes", () => {
    const providerTargets: QuoteSubscriptionTarget[] = [];
    const seenQuotes: Array<{ symbol: string; price: number }> = [];
    const streamingProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      subscribeQuotes(targets, onQuote) {
        providerTargets.push(...targets);
        onQuote(targets[0]!, {
          symbol: "HEXA B",
          price: 0,
          currency: "SEK",
          change: 0,
          changePercent: 0,
          lastUpdated: Date.now(),
          listingExchangeName: "SFB",
          dataSource: "delayed",
        });
        return () => {};
      },
    };

    const router = new AssetDataRouter(fallbackProvider, [streamingProvider]);
    const unsubscribe = router.subscribeQuotes([{
      symbol: "HEXA B",
      exchange: "SFB",
      route: "provider",
    }], (_target, quote) => {
      seenQuotes.push({ symbol: quote.symbol, price: quote.price });
    });

    expect(providerTargets).toEqual([{
      symbol: "HEXA B",
      exchange: "SFB",
      route: "provider",
    }]);
    expect(seenQuotes).toEqual([]);

    unsubscribe();
  });

  test("returns quote-only financials for option tickers when snapshots are unavailable", async () => {
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials();
      },
      async getQuote(ticker) {
        return makeQuote({
          symbol: ticker,
          price: 252.375,
          change: 1.5,
          changePercent: 0.6,
          bid: 250.25,
          ask: 254.5,
          mark: 252.375,
          providerId: "gloomberb-cloud",
          dataSource: "delayed",
        });
      },
    });

    const financials = await router.getTickerFinancials("AMD   270917C00230000");

    expect(financials.quote?.symbol).toBe("AMD   270917C00230000");
    expect(financials.quote?.mark).toBe(252.375);
    expect(financials.annualStatements).toEqual([]);
    expect(financials.priceHistory).toEqual([]);
  });

  test("merges cached broker financials with cached fallback fundamentals", async () => {
    const dbPath = createTempDbPath("cache-merge");
    const persistence = new AppPersistence(dbPath);
    const providerCalls = { broker: 0, fallback: 0 };
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        providerCalls.fallback += 1;
        return makeFinancials({
          annualStatements: [{ date: "2025-12-31", totalRevenue: 1000 }],
          quarterlyStatements: [{ date: "2025-12-31", totalRevenue: 250 }],
          fundamentals: { revenue: 1000, netIncome: 200 },
        });
      },
    }, [], persistence.resources);
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getTickerFinancials() {
        providerCalls.broker += 1;
        return makeFinancials({
          quote: makeQuote({
            price: 125,
            change: 2,
            changePercent: 1.6,
          }),
          fundamentals: {},
        });
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const merged = await router.getTickerFinancials("AAPL", "NASDAQ", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });
    expect(merged.quote?.price).toBe(125);
    expect(merged.fundamentals?.revenue).toBe(1000);
    expect(providerCalls.broker).toBe(1);
    expect(providerCalls.fallback).toBe(1);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "AAPL",
      exchange: "NASDAQ",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    }], { allowExpired: true });
    expect(cached.get("AAPL")?.quote?.price).toBe(125);
    expect(cached.get("AAPL")?.fundamentals?.revenue).toBe(1000);
    persistence.close();
  });

  test("keeps broker price authority when a fallback quote is off by a likely 100x unit mismatch", async () => {
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials({
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 0.245 }],
          quote: makeQuote({
            symbol: "IQE.L",
            listingExchangeName: "LSE",
            providerId: "yahoo",
            price: 0.245,
            currency: "GBP",
            change: -0.021,
            changePercent: -7.89,
            dataSource: "delayed",
          }),
          fundamentals: { revenue: 1000 },
        });
      },
    });
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getTickerFinancials() {
        return makeFinancials({
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 24.5 }],
          quote: makeQuote({
            symbol: "IQE",
            providerId: "ibkr",
            price: 24.5,
            currency: "GBP",
            change: -2.1,
            changePercent: -7.89,
            dataSource: "live",
          }),
          fundamentals: { netIncome: 200 },
        });
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const merged = await router.getTickerFinancials("IQE", "LSE", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });

    expect(merged.quote?.price).toBe(24.5);
    expect(merged.quote?.provenance?.rejectedPriceProviders).toContain("yahoo");
    expect(merged.priceHistory[0]?.close).toBe(0.245);
    expect(merged.fundamentals?.netIncome).toBe(200);
  });

  test("preserves fallback profile data when broker already has fundamentals", async () => {
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials({
          profile: {
            description: "Builds hardware and software.",
            sector: "Technology",
            industry: "Consumer Electronics",
          },
        });
      },
    });
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getTickerFinancials() {
        return makeFinancials({
          fundamentals: { revenue: 1000, netIncome: 200 },
        });
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [brokerInstance()]);

    const merged = await router.getTickerFinancials("AAPL", "NASDAQ", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });
    expect(merged.fundamentals?.revenue).toBe(1000);
    expect(merged.profile?.description).toBe("Builds hardware and software.");
    expect(merged.profile?.sector).toBe("Technology");
  });

  test("merges fallback provider statement arrays without taking over preferred financials", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          quote: makeQuote({
            price: 125,
            change: 2,
            changePercent: 1.6,
          }),
          fundamentals: {
            trailingPE: 25,
          },
        });
      },
    };
    let yahooCalls = 0;
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        yahooCalls += 1;
        return makeFinancials({
          annualStatements: [{ date: "2025-12-31", totalRevenue: 391035000000 }],
          quarterlyStatements: [{ date: "2026-03-31", totalRevenue: 95359000000 }],
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 124 }],
          quote: makeQuote({
            price: 124,
            change: 1,
            changePercent: 0.8,
            marketCap: 2_000_000_000,
          }),
          fundamentals: {
            forwardPE: 22,
          },
        });
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const merged = await router.getTickerFinancials("AAPL", "NASDAQ");

    expect(merged.quote?.price).toBe(125);
    expect(merged.quote?.marketCap).toBeUndefined();
    expect(merged.fundamentals?.trailingPE).toBe(25);
    expect(merged.fundamentals?.forwardPE).toBeUndefined();
    expect(merged.priceHistory).toEqual([]);
    expect(merged.annualStatements).toEqual([{ date: "2025-12-31", totalRevenue: 391035000000 }]);
    expect(merged.quarterlyStatements).toEqual([{ date: "2026-03-31", totalRevenue: 95359000000 }]);
    expect(yahooCalls).toBe(1);
  });

  test("supplements shallow preferred provider statement history", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          profile: { sector: "Technology" },
          quote: makeQuote({ symbol: "LINK", price: 25 }),
          quarterlyStatements: [
            { date: "2025-03-31", operatingCashFlow: -271_000 },
            { date: "2025-06-30", operatingCashFlow: -138_000 },
            { date: "2025-09-30", operatingCashFlow: 653_000 },
            { date: "2025-12-31", operatingCashFlow: -356_000 },
            { date: "2026-03-31", operatingCashFlow: -543_000 },
          ],
        });
      },
    };
    let yahooCalls = 0;
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        yahooCalls += 1;
        return makeFinancials({
          quarterlyStatements: [
            { date: "2024-03-31", operatingCashFlow: -601_000 },
            { date: "2024-06-30", operatingCashFlow: -488_000 },
            { date: "2024-09-30", operatingCashFlow: -204_000 },
            { date: "2024-12-31", operatingCashFlow: 122_000 },
          ],
        });
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const merged = await router.getTickerFinancials("LINK", "NASDAQ");

    expect(yahooCalls).toBe(1);
    expect(merged.profile?.sector).toBe("Technology");
    expect(merged.quote?.price).toBe(25);
    expect(merged.quarterlyStatements.map((row) => row.date)).toEqual([
      "2024-03-31",
      "2024-06-30",
      "2024-09-30",
      "2024-12-31",
      "2025-03-31",
      "2025-06-30",
      "2025-09-30",
      "2025-12-31",
      "2026-03-31",
    ]);
  });

  test("enriches shallow batch provider statement history through the single financial route", async () => {
    const shallowCloudRows = [
      { date: "2025-03-31", eps: 0.44 },
      { date: "2025-06-30", eps: 0.54 },
      { date: "2025-09-30", eps: 0.75 },
      { date: "2025-12-31", eps: 0.92 },
      { date: "2026-03-31", eps: 0.84 },
    ];
    let cloudBatchCalls = 0;
    let cloudSingleCalls = 0;
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        cloudSingleCalls += 1;
        return makeFinancials({
          profile: { sector: "Technology" },
          quote: makeQuote({ symbol: "AMD", price: 125 }),
          quarterlyStatements: shallowCloudRows,
        });
      },
      async getTickerFinancialsBatch(targets) {
        cloudBatchCalls += 1;
        return targets.map((target) => ({
          target,
          financials: makeFinancials({
            profile: { sector: "Technology" },
            quote: makeQuote({ symbol: target.symbol, price: 125 }),
            quarterlyStatements: shallowCloudRows,
          }),
        }));
      },
    };
    let yahooCalls = 0;
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        yahooCalls += 1;
        return makeFinancials({
          quarterlyStatements: [
            { date: "2024-03-31", eps: 0.07 },
            { date: "2024-06-30", eps: 0.16 },
            { date: "2024-09-30", eps: 0.47 },
            { date: "2024-12-31", eps: 0.29 },
          ],
        });
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const results = await router.getTickerFinancialsBatch([{ symbol: "AMD", exchange: "NASDAQ" }], { forceRefresh: true });
    const financials = results[0]?.financials;

    expect(cloudBatchCalls).toBe(1);
    expect(cloudSingleCalls).toBe(1);
    expect(yahooCalls).toBe(1);
    expect(financials?.profile?.sector).toBe("Technology");
    expect(financials?.quote?.symbol).toBe("AMD");
    expect(financials?.quarterlyStatements.map((row) => row.date)).toEqual([
      "2024-03-31",
      "2024-06-30",
      "2024-09-30",
      "2024-12-31",
      "2025-03-31",
      "2025-06-30",
      "2025-09-30",
      "2025-12-31",
      "2026-03-31",
    ]);
  });

  test("refreshes shallow cached provider statement history", async () => {
    const dbPath = createTempDbPath("cached-shallow-statement-history");
    const persistence = new AppPersistence(dbPath);
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          profile: { sector: "Technology" },
          quote: makeQuote({ symbol: "LINK", price: 25 }),
          quarterlyStatements: [
            { date: "2025-03-31", operatingCashFlow: -271_000 },
            { date: "2025-06-30", operatingCashFlow: -138_000 },
            { date: "2025-09-30", operatingCashFlow: 653_000 },
            { date: "2025-12-31", operatingCashFlow: -356_000 },
            { date: "2026-03-31", operatingCashFlow: -543_000 },
          ],
        });
      },
    };
    let yahooCalls = 0;
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        yahooCalls += 1;
        return makeFinancials({
          quarterlyStatements: [
            { date: "2024-03-31", operatingCashFlow: -601_000 },
            { date: "2024-06-30", operatingCashFlow: -488_000 },
            { date: "2024-09-30", operatingCashFlow: -204_000 },
            { date: "2024-12-31", operatingCashFlow: 122_000 },
          ],
        });
      },
    };

    try {
      const seedRouter = new AssetDataRouter(null, [cloudProvider], persistence.resources);
      await seedRouter.getTickerFinancials("LINK", "NASDAQ");

      const cachedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
      const merged = await cachedRouter.getTickerFinancials("LINK", "NASDAQ");

      expect(yahooCalls).toBe(1);
      expect(merged.quarterlyStatements).toHaveLength(9);
    } finally {
      persistence.close();
    }
  });

  test("fills missing preferred statement fields from richer fallback rows", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          annualStatements: [{ date: "2025-12-31", totalRevenue: 1000 }],
          quote: makeQuote({
            symbol: "AMD",
            price: 125,
            change: 2,
            changePercent: 1.6,
          }),
        });
      },
    };
    let yahooCalls = 0;
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        yahooCalls += 1;
        return makeFinancials({
          annualStatements: [{
            date: "2025-12-31",
            totalRevenue: 900,
            accountsReceivable: 250,
            inventory: 125,
          }],
        });
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const merged = await router.getTickerFinancials("AMD", "NASDAQ");

    expect(merged.quote?.price).toBe(125);
    expect(merged.annualStatements).toEqual([{
      date: "2025-12-31",
      totalRevenue: 1000,
      accountsReceivable: 250,
      inventory: 125,
    }]);
    expect(yahooCalls).toBe(1);
  });

  test("fills unusable preferred provider financial quotes from a later provider", async () => {
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          profile: { sector: "Industrials" },
          quote: makeQuote({
            symbol: "HY9H",
            price: 1295,
            change: -95,
            changePercent: -6.83,
            lastUpdated: Date.now() - 20 * 60_000,
            listingExchangeName: "FWB2",
            marketState: "REGULAR",
          }),
        });
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        return makeFinancials({
          quote: makeQuote({
            symbol: "HY9H.F",
            price: 1305,
            change: -85,
            changePercent: -6.12,
            lastUpdated: Date.now(),
            listingExchangeName: "FWB2",
            marketState: "REGULAR",
          }),
        });
      },
    };

    const router = new AssetDataRouter(yahooProvider, [cloudProvider]);
    const merged = await router.getTickerFinancials("HY9H", "FWB2", { cacheMode: "refresh" });

    expect(merged.profile?.sector).toBe("Industrials");
    expect(merged.quote?.symbol).toBe("HY9H.F");
    expect(merged.quote?.price).toBe(1305);
    expect(merged.quote?.changePercent).toBe(-6.12);
  });

  test("caches the preferred provider financial snapshot without merging fallback snapshots", async () => {
    const dbPath = createTempDbPath("cached-provider-financial-preferred");
    const persistence = new AppPersistence(dbPath);

    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        return makeFinancials({
          quote: makeQuote({
            price: 125,
            change: 2,
            changePercent: 1.6,
          }),
          fundamentals: {
            trailingPE: 25,
          },
          profile: {
            sector: "Technology",
          },
        });
      },
    };
    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 1000,
      async getTickerFinancials() {
        return makeFinancials({
          priceHistory: [{ date: new Date("2026-03-28T00:00:00Z"), close: 124 }],
          quote: makeQuote({
            price: 124,
            change: 1,
            changePercent: 0.8,
            marketCap: 2_000_000_000,
          }),
          fundamentals: {
            forwardPE: 22,
          },
        });
      },
    };

    const seedRouter = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);
    const seeded = await seedRouter.getTickerFinancials("AAPL", "NASDAQ");
    expect(seeded.quote?.price).toBe(125);
    expect(seeded.quote?.marketCap).toBeUndefined();

    let cloudCalls = 0;
    let yahooCalls = 0;
    const cachedRouter = new AssetDataRouter({
      ...yahooProvider,
      async getTickerFinancials() {
        yahooCalls += 1;
        throw new Error("expected cached yahoo financials");
      },
    }, [{
      ...cloudProvider,
      async getTickerFinancials() {
        cloudCalls += 1;
        throw new Error("expected cached cloud financials");
      },
    }], persistence.resources);

    const cached = await cachedRouter.getTickerFinancials("AAPL", "NASDAQ");

    expect(cloudCalls).toBe(0);
    expect(yahooCalls).toBe(0);
    expect(cached.quote?.price).toBe(125);
    expect(cached.quote?.marketCap).toBeUndefined();
    expect(cached.fundamentals?.trailingPE).toBe(25);
    expect(cached.fundamentals?.forwardPE).toBeUndefined();
    expect(cached.profile?.sector).toBe("Technology");
    expect(cached.priceHistory).toEqual([]);

    persistence.close();
  });

  test("refreshes missing profile data even when cached financials exist", async () => {
    const dbPath = createTempDbPath("cache-profile-refresh");
    const persistence = new AppPersistence(dbPath);

    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getTickerFinancials() {
        return makeFinancials({
          fundamentals: { revenue: 1000, netIncome: 200 },
        });
      },
    };

    const config = createBrokerConfig([brokerInstance()]);

    const seedRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials();
      },
    }, [], persistence.resources);
    attachTestRegistry(seedRouter, { brokers: [["ibkr", broker]] });
    seedRouter.setConfigAccessor(() => config);

    const seeded = await seedRouter.getTickerFinancials("PSTG", "NYSE", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });
    expect(seeded.profile).toBeUndefined();

    const refreshedRouter = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials({
          profile: {
            description: "Provides enterprise data storage platforms.",
            sector: "Technology",
            industry: "Computer Hardware",
          },
        });
      },
    }, [], persistence.resources);
    attachTestRegistry(refreshedRouter, { brokers: [["ibkr", broker]] });
    refreshedRouter.setConfigAccessor(() => config);

    const refreshed = await refreshedRouter.getTickerFinancials("PSTG", "NYSE", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-work",
    });
    expect(refreshed.fundamentals?.revenue).toBe(1000);
    expect(refreshed.profile?.description).toBe("Provides enterprise data storage platforms.");

    persistence.close();
  });

  test("does not reuse another broker instance's financials when a specific instance is requested", async () => {
    const dbPath = createTempDbPath("instance-scoped-financials");
    const persistence = new AppPersistence(dbPath);
    const router = new AssetDataRouter({
      ...fallbackProvider,
      async getTickerFinancials() {
        return makeFinancials({
          quote: makeQuote({
            symbol: "IQE.L",
            listingExchangeName: "LSE",
            providerId: "yahoo",
            price: 0.245,
            currency: "GBP",
            dataSource: "delayed",
          }),
        });
      },
    }, [], persistence.resources);
    const broker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      async validate() {
        return true;
      },
      async importPositions() {
        return [];
      },
      async getTickerFinancials(_ticker, instance) {
        if (instance.id === "ibkr-flex") {
          throw new Error("Gateway mode is required for broker market data");
        }
        return makeFinancials({
          quote: makeQuote({
            symbol: "IQE",
            providerId: "ibkr",
            price: 24.5,
            currency: "GBP",
            dataSource: "live",
          }),
        });
      },
    };

    attachTestRegistry(router, { brokers: [["ibkr", broker]] });
    setBrokerInstances(router, [
      brokerInstance({ id: "ibkr-flex", label: "Flex", connectionMode: "flex" }),
      brokerInstance({ id: "ibkr-live", label: "Live" }),
    ]);

    const live = await router.getTickerFinancials("IQE", "LSE", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-live",
    });
    expect(live.quote?.price).toBe(24.5);

    const flex = await router.getTickerFinancials("IQE", "LSE", {
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
    });
    expect(flex.quote?.price).toBe(0.245);

    const cached = router.getCachedFinancialsForTargets([{
      symbol: "IQE",
      exchange: "LSE",
      brokerId: "ibkr",
      brokerInstanceId: "ibkr-flex",
    }], { allowExpired: true });
    expect(cached.get("IQE")?.quote?.price).toBe(0.245);

    persistence.close();
  });

  test("returns merged cached provider financials on cold start when sub-unit quotes exist", async () => {
    const dbPath = createTempDbPath("cached-sub-unit-financials");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();

    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:14075064",
        variantKey: "exchange=LSE",
        sourceKey: "provider:gloomberb-cloud",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "IQE",
          price: 23.1,
          currency: "GBp",
          change: -1.4,
          changePercent: -5.71,
          previousClose: 24.5,
          lastUpdated: now,
          dataSource: "delayed",
        }),
        profile: {
          description: "Cloud profile",
        },
      }),
      {
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );
    persistence.resources.set(
      {
        namespace: "market",
        kind: "financials",
        entityKey: "contract:14075064",
        variantKey: "exchange=LSE",
        sourceKey: "provider:yahoo",
      },
      makeFinancials({
        quote: makeQuote({
          symbol: "IQE.L",
          providerId: "yahoo",
          price: 0.231,
          currency: "GBP",
          change: -0.014,
          changePercent: -5.71,
          previousClose: 0.245,
          lastUpdated: now,
          dataSource: "delayed",
        }),
        fundamentals: {
          revenue: 1000,
        },
      }),
      {
        cachePolicy: { staleMs: 60_000, expireMs: 60_000 },
        fetchedAt: now,
      },
    );

    const yahooProvider: DataProvider = {
      ...fallbackProvider,
      id: "yahoo",
      name: "Yahoo",
      priority: 200,
      async getTickerFinancials() {
        throw new Error("should not fetch yahoo financials");
      },
    };
    const cloudProvider: DataProvider = {
      ...fallbackProvider,
      id: "gloomberb-cloud",
      name: "Cloud",
      priority: 100,
      async getTickerFinancials() {
        throw new Error("should not fetch cloud financials");
      },
    };
    const router = new AssetDataRouter(yahooProvider, [cloudProvider], persistence.resources);

    const financials = await router.getTickerFinancials("IQE", "LSE", {
      instrument: {
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-personal",
        conId: 14075064,
        symbol: "IQE",
      },
    });

    expect(financials.quote?.price).toBe(0.231);
    expect(financials.quote?.currency).toBe("GBP");
    expect(financials.fundamentals?.revenue).toBe(1000);
    expect(financials.profile?.description).toBe("Cloud profile");

    persistence.close();
  });

});
