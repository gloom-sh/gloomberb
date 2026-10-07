import { afterEach, describe, expect, jest, test } from "bun:test";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import {
  attachMarketMoversPersistence,
  fetchPreferredMarketMovers,
  fetchScreener,
  fetchScreenerResult,
  parseScreenerResponse,
  parseTrendingResponse,
  resetMarketMoversPersistence,
  type MarketScreenerApi,
  type PreferredMarketMoverSources,
} from "./screener";

const SAMPLE_SCREENER_RESPONSE = { quotes: [
  { symbol: "AAPL", name: "Apple Inc.", price: 185.5, change: 3.25, changePercent: 1.78, volume: 52_000_000, avgVolume: 20_000_000,
    marketCap: 2_900_000_000_000, currency: "USD", fiftyTwoWeekHigh: 199.62, fiftyTwoWeekLow: 140, dayHigh: 186, dayLow: 182, exchange: "NasdaqGS" },
  { symbol: "MSFT", name: "Microsoft Corporation", price: 415, change: -2.1, changePercent: -0.5, volume: 18_000_000, avgVolume: 25_000_000,
    marketCap: 3_100_000_000_000, currency: "USD", exchange: "NasdaqGS" },
] };
const response = () => ({ status: "success" as const, data: { ...SAMPLE_SCREENER_RESPONSE, source: "gloom" as const, stale: false, asOf: "2026-08-14" } }) as Awaited<ReturnType<MarketScreenerApi["getMarketMovers"]>>;
afterEach(() => {
  jest.useRealTimers();
  resetMarketMoversPersistence();
});

test("trending ignores malformed symbols without inventing rows", () => {
  expect(parseTrendingResponse([{ symbol: null }, { symbol: "SPY" }])).toEqual([{ symbol: "SPY" }]);
});

describe("fetchScreener", () => {
  test("uses Cloud rankings and prices while retaining backend metadata", async () => {
    const calls: unknown[] = [];
    const marketQuotes = parseScreenerResponse(SAMPLE_SCREENER_RESPONSE);
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
      fetchMarket: async () => ({ data: marketQuotes, stale: false }),
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

  test("unqualified direct averages retain the public average without coercing or fabricating a ratio", async () => {
    const invalid = [undefined, null, "100", 0, -1, NaN, Infinity, -Infinity];
    const symbols = invalid.map((_, index) => `INVALID${index}`);
    const marketQuotes = parseScreenerResponse({ quotes: symbols.map(symbol => ({ symbol, volume: 1, avgVolume: 20_000_000 })) });
    const result = await fetchPreferredMarketMovers("most_actives", 25, undefined, {
      isCloudEligible: () => true,
      fetchCloud: async () => ({ status: "success", data: {
        providerId: "gloomberb-cloud", category: "most-active", asOf: "2026-10-07T09:30:00.000Z",
        items: [...symbols, "MISSING"].map((symbol, index) => ({
          rank: index + 1, symbol, name: symbol, price: 190, change: 0, changePercent: 0,
          volume: 60_000_000, avgVolume: invalid[index] as number | undefined,
          currency: "USD", exchange: "NASDAQ", lastUpdated: 1, dataSource: "live" as const,
        })),
      } }),
      fetchMarket: async () => ({ data: marketQuotes, stale: false }),
    });
    expect(result.quotes.map(quote => [quote.symbol, quote.avgVolume, quote.volumeRatio])).toEqual([
      ...symbols.map(symbol => [symbol, 20_000_000, 3]),
      ["MISSING", null, null],
    ]);
  });

  test.each([
    { options: undefined, waitMs: 1_500 },
    { options: { metadataWaitMs: 10_000 }, waitMs: 10_000 },
  ])("metadata that never arrives leaves live rows available after $waitMs ms", async ({ options, waitMs }) => {
    jest.useFakeTimers();
    const sources: PreferredMarketMoverSources = {
      isCloudEligible: () => true,
      fetchCloud: async () => ({ status: "success", data: { providerId: "gloomberb-cloud", category: "most-active", asOf: "2026-10-07T09:30:00.000Z", items: [
        { rank: 1, symbol: "AAPL", name: "AAPL", price: 190, change: 0, changePercent: 0, volume: 60_000_000, currency: "USD", exchange: "NASDAQ", lastUpdated: 1, dataSource: "live" },
      ] } }),
      fetchMarket: () => new Promise(() => {}),
    };
    let settled = false;
    const loading = fetchPreferredMarketMovers("most_actives", 25, options, sources).then(result => {
      settled = true;
      return result;
    });
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    jest.advanceTimersByTime(waitMs - 1);
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect((await loading).quotes[0]).toMatchObject({ symbol: "AAPL", avgVolume: null, volumeRatio: null });
  });

  test("keeps free accounts on backend without calling the Pro screener", async () => {
    let cloudCalls = 0;
    const sources: PreferredMarketMoverSources = {
      isCloudEligible: () => false,
      fetchCloud: async () => {
        cloudCalls += 1;
        throw new Error("not expected");
      },
      fetchMarket: async () => ({ data: parseScreenerResponse(SAMPLE_SCREENER_RESPONSE), stale: false }),
    };

    const result = await fetchPreferredMarketMovers(
      "most_actives",
      25,
      undefined,
      sources,
    );

    expect(cloudCalls).toBe(0);
    expect(result.source).toBe("gloom");
    expect(result.quotes.map((quote) => quote.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  test("ranks each list on the metric it displays, not the vendor's snapshot order", async () => {
    // backend ranks on an older snapshot than the live quote fields it returns.
    const quote = (symbol: string, volume: number | null, changePercent: number | null) => ({
      ...parseScreenerResponse(SAMPLE_SCREENER_RESPONSE)[0]!, symbol, volume, changePercent,
    });
    const quotes = [quote("NVDA", 93_300_000, 0.66), quote("INTC", 107_680_000, 1.71), quote("NONE", null, null), quote("GRAB", 180_760_000, -8.9)];
    const sources: PreferredMarketMoverSources = {
      isCloudEligible: () => false,
      fetchCloud: async () => { throw new Error("not expected"); },
      fetchMarket: async () => ({ data: quotes, stale: false }),
    };
    const symbols = async (category: "most_actives" | "day_gainers" | "day_losers") => (
      (await fetchPreferredMarketMovers(category, 25, undefined, sources)).quotes.map((entry) => entry.symbol)
    );

    expect(await symbols("most_actives")).toEqual(["GRAB", "INTC", "NVDA", "NONE"]);
    expect(await symbols("day_gainers")).toEqual(["INTC", "NVDA", "GRAB", "NONE"]);
    expect(await symbols("day_losers")).toEqual(["GRAB", "NVDA", "INTC", "NONE"]);
  });

  test("reports a cached backend fallback as stale", async () => {
    // Regression: an expired cache served after a failed fetch reported
    // stale: false, so the pane's stale marker never appeared.
    const persistence = new MemoryPluginPersistence();
    attachMarketMoversPersistence(persistence);
    let calls = 0;
    const api: MarketScreenerApi = {
      async getMarketMovers() {
        calls += 1;
        if (calls === 1) return response();
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

  test("rehydrates persisted screener results without refetching", async () => {
    const persistence = new MemoryPluginPersistence();
    attachMarketMoversPersistence(persistence);
    let calls = 0;
    const api: MarketScreenerApi = {
      async getMarketMovers() {
        calls += 1;
        return response();
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

test("mover prices keep the currency's minor unit and a sub-cent coin's digits", async () => {
  const { formatMoverPrice, moverReferencePrice } = await import("./model");
  expect(formatMoverPrice(0.00001234, "USD")).toBe("$0.00001234");
  expect(formatMoverPrice(33.4, "USD")).toBe("$33.40");
  expect(formatMoverPrice(45678, "JPY")).toBe("¥45,678");
  expect(formatMoverPrice(1234.5, "GBp")).toBe("£12.35");
  // Decimals come from the session's close, never the tick: a sub-dollar stock
  // landing on $0.50 or crossing $1 keeps its four.
  expect(formatMoverPrice(0.5, "USD", moverReferencePrice({ price: 0.5, change: -0.0123 }))).toBe("$0.5000");
  expect(formatMoverPrice(1.2, "USD", moverReferencePrice({ price: 1.2, change: 0.4 }))).toBe("$1.2000");
});

test("backend stale snapshots remain stale after persistence and cannot mask a refresh failure", async () => {
  const persistence = new MemoryPluginPersistence();
  attachMarketMoversPersistence(persistence);
  let calls = 0;
  const api: MarketScreenerApi = { getMarketMovers: async () => {
    calls++;
    if (calls > 1) throw new Error("Unavailable");
    const value = response();
    return { ...value, stale: true };
  } };
  expect((await fetchScreenerResult("day_gainers", 25, api, { cache: true })).stale).toBe(true);
  resetMarketMoversPersistence();
  attachMarketMoversPersistence(persistence);
  const hydrated = await fetchScreenerResult("day_gainers", 25, api, { cache: true });
  expect(hydrated.stale).toBe(true);
  expect(hydrated.data.map(row => row.symbol)).toEqual(["AAPL", "MSFT"]);
  expect(calls).toBe(2);
});
