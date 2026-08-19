import { afterEach, describe, expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  attachMarketMoversPersistence,
  createYahooScreenerApi,
  fetchPreferredMarketMovers,
  fetchScreener,
  fetchScreenerResult,
  parseScreenerResponse,
  parseTrendingResponse,
  resetMarketMoversPersistence,
  type YahooScreenerApi,
  type PreferredMarketMoverSources,
} from "./screener";

const SAMPLE_SCREENER_RESPONSE = {
  finance: {
    result: [
      {
        quotes: [
          {
            symbol: "AAPL",
            shortName: "Apple Inc.",
            regularMarketPrice: 185.5,
            regularMarketChange: 3.25,
            regularMarketChangePercent: 1.78,
            regularMarketVolume: 52_000_000,
            averageDailyVolume3Month: 20_000_000,
            marketCap: 2_900_000_000_000,
            currency: "USD",
            fiftyTwoWeekHigh: 199.62,
            fiftyTwoWeekLow: 140.0,
            regularMarketDayHigh: 186.0,
            regularMarketDayLow: 182.0,
            fullExchangeName: "NasdaqGS",
          },
          {
            symbol: "MSFT",
            shortName: "Microsoft Corporation",
            regularMarketPrice: 415.0,
            regularMarketChange: -2.1,
            regularMarketChangePercent: -0.5,
            regularMarketVolume: 18_000_000,
            averageDailyVolume3Month: 25_000_000,
            marketCap: 3_100_000_000_000,
            currency: "USD",
            fullExchangeName: "NasdaqGS",
          },
        ],
      },
    ],
    error: null,
  },
};

const SAMPLE_TRENDING_RESPONSE = {
  finance: {
    result: [
      {
        quotes: [
          { symbol: "NVDA" },
          { symbol: "TSLA" },
        ],
      },
    ],
    error: null,
  },
};

afterEach(() => {
  resetMarketMoversPersistence();
});

describe("parseScreenerResponse", () => {
  test("maps Yahoo Finance fields to ScreenerQuote", () => {
    const results = parseScreenerResponse(SAMPLE_SCREENER_RESPONSE);
    expect(results).toHaveLength(2);

    const apple = results[0]!;
    expect(apple.symbol).toBe("AAPL");
    expect(apple.name).toBe("Apple Inc.");
    expect(apple.price).toBe(185.5);
    expect(apple.change).toBe(3.25);
    expect(apple.changePercent).toBe(1.78);
    expect(apple.volume).toBe(52_000_000);
    expect(apple.avgVolume).toBe(20_000_000);
    expect(apple.volumeRatio).toBeCloseTo(2.6, 1);
    expect(apple.marketCap).toBe(2_900_000_000_000);
    expect(apple.currency).toBe("USD");
    expect(apple.fiftyTwoWeekHigh).toBe(199.62);
    expect(apple.fiftyTwoWeekLow).toBe(140.0);
    expect(apple.exchange).toBe("NasdaqGS");

    const msft = results[1]!;
    expect(msft.symbol).toBe("MSFT");
    expect(msft.change).toBe(-2.1);
    expect(msft.changePercent).toBe(-0.5);
    expect(msft.volumeRatio).toBeCloseTo(0.72, 1);
  });

  test("skips entries without a string symbol", () => {
    const data = {
      finance: {
        result: [{ quotes: [{ symbol: 123 }, { symbol: "AMD", regularMarketPrice: 100 }] }],
      },
    };
    const results = parseScreenerResponse(data);
    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe("AMD");
  });

  test("falls back to symbol when shortName and longName are absent", () => {
    const data = {
      finance: {
        result: [{ quotes: [{ symbol: "XYZ", regularMarketPrice: 10 }] }],
      },
    };
    const results = parseScreenerResponse(data);
    expect(results[0]!.name).toBe("XYZ");
  });
});

describe("parseTrendingResponse", () => {
  test("extracts symbols from trending response", () => {
    const results = parseTrendingResponse(SAMPLE_TRENDING_RESPONSE);
    expect(results).toHaveLength(2);
    expect(results[0]!.symbol).toBe("NVDA");
    expect(results[1]!.symbol).toBe("TSLA");
  });

  test("skips entries without a string symbol", () => {
    const data = {
      finance: {
        result: [{ quotes: [{ symbol: null }, { symbol: "SPY" }] }],
      },
    };
    const results = parseTrendingResponse(data);
    expect(results).toHaveLength(1);
    expect(results[0]!.symbol).toBe("SPY");
  });
});

describe("fetchScreener", () => {
  test("uses Cloud rankings and prices while retaining Yahoo metadata", async () => {
    const calls: unknown[] = [];
    const yahooQuotes = parseScreenerResponse(SAMPLE_SCREENER_RESPONSE);
    const sources: PreferredMarketMoverSources = {
      isCloudEligible: () => true,
      fetchCloud: async (category, count, mode) => {
        calls.push({ category, count, mode });
        return {
          status: "success",
          data: {
            providerId: "gloomberb-cloud",
            category,
            asOf: "2026-08-14T23:59:00.000Z",
            items: [
              {
                rank: 1,
                symbol: "AAPL",
                name: "AAPL",
                price: 190,
                change: 7.75,
                changePercent: 4.25,
                volume: 60_000_000,
                currency: "USD",
                exchange: "NASDAQ",
                lastUpdated: 1_700_000_000_000,
                dataSource: "live",
              },
            ],
          },
        };
      },
      fetchYahoo: async () => ({ data: yahooQuotes, stale: false }),
    };

    const result = await fetchPreferredMarketMovers(
      "day_gainers",
      25,
      { forceRefresh: true },
      sources,
    );

    expect(calls).toEqual([
      { category: "gainers", count: 25, mode: "refresh" },
    ]);
    expect(result).toMatchObject({ source: "cloud", stale: false });
    expect(result.quotes[0]).toMatchObject({
      symbol: "AAPL",
      name: "Apple Inc.",
      price: 190,
      changePercent: 4.25,
      volume: 60_000_000,
      avgVolume: 20_000_000,
      marketCap: 2_900_000_000_000,
      lastUpdated: 1_700_000_000_000,
    });
  });

  test("keeps free accounts on Yahoo without calling the Pro screener", async () => {
    let cloudCalls = 0;
    const sources: PreferredMarketMoverSources = {
      isCloudEligible: () => false,
      fetchCloud: async () => {
        cloudCalls += 1;
        throw new Error("not expected");
      },
      fetchYahoo: async () => ({ data: parseScreenerResponse(SAMPLE_SCREENER_RESPONSE), stale: false }),
    };

    const result = await fetchPreferredMarketMovers(
      "most_actives",
      25,
      undefined,
      sources,
    );

    expect(cloudCalls).toBe(0);
    expect(result.source).toBe("yahoo");
    expect(result.quotes.map((quote) => quote.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  test("reports a cached Yahoo fallback as stale", async () => {
    // Regression: an expired cache served after a failed fetch reported
    // stale: false, so the pane's stale marker never appeared.
    const persistence = new MemoryPluginPersistence();
    attachMarketMoversPersistence(persistence);
    let calls = 0;
    const api: YahooScreenerApi = {
      async fetchJson<T = unknown>() {
        calls += 1;
        if (calls === 1) return SAMPLE_SCREENER_RESPONSE as T;
        throw new Error("upstream down");
      },
    };

    const fresh = await fetchScreenerResult("day_gainers", 2, api, { cache: true });
    expect(fresh.stale).toBe(false);

    const fallback = await fetchScreenerResult("day_gainers", 2, api, {
      cache: true,
      forceRefresh: true,
    });
    expect(fallback.stale).toBe(true);
    expect(fallback.data.map((quote) => quote.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  test("falls back to the secondary Yahoo host when the primary host fails", async () => {
    const requestedHosts: string[] = [];
    const userAgents: string[] = [];
    const api = createYahooScreenerApi(async (url, init) => {
      const parsed = new URL(url);
      requestedHosts.push(parsed.host);
      userAgents.push(String((init?.headers as Record<string, string> | undefined)?.["User-Agent"] ?? ""));

      if (parsed.host === "query2.finance.yahoo.com") {
        return new Response("Forbidden", { status: 403 });
      }

      expect(parsed.pathname).toBe("/v1/finance/screener/predefined/saved");
      expect(parsed.searchParams.get("formatted")).toBe("false");
      expect(parsed.searchParams.get("lang")).toBe("en-US");
      expect(parsed.searchParams.get("region")).toBe("US");
      expect(parsed.searchParams.get("scrIds")).toBe("day_gainers");
      expect(parsed.searchParams.get("count")).toBe("2");
      return Response.json(SAMPLE_SCREENER_RESPONSE);
    });

    const results = await fetchScreener("day_gainers", 2, api);

    expect(requestedHosts).toEqual([
      "query2.finance.yahoo.com",
      "query1.finance.yahoo.com",
    ]);
    expect(userAgents.every((agent) => agent.includes("Mozilla/5.0"))).toBe(true);
    expect(results.map((result) => result.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  test("rehydrates persisted screener results without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachMarketMoversPersistence(persistence);
    let calls = 0;
    const api: YahooScreenerApi = {
      async fetchJson<T = unknown>() {
        calls += 1;
        return SAMPLE_SCREENER_RESPONSE as T;
      },
    };

    await fetchScreener("day_gainers", 2, api, { cache: true });

    resetMarketMoversPersistence();
    attachMarketMoversPersistence(persistence);

    const results = await fetchScreener("day_gainers", 2, api, { cache: true });

    expect(calls).toBe(1);
    expect(results.map((result) => result.symbol)).toEqual(["AAPL", "MSFT"]);
  });
});
