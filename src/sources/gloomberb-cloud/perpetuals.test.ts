import { afterEach, describe, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { PerpBoardPayload, PerpBoardQuery, PerpBoardRow, PerpHistoryPayload, PerpHistoryQuery, PerpMarketPayload } from "../../api-client/perps";
import { perpetualListing } from "../../tickers/perpetual-listing";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";
import { getPerpetualHistory, PERPETUAL_HISTORY_LOCKED, perpetualQuote, searchPerpetualMarkets, streamedPerpetualQuote } from "./perpetuals";

/** Hyperliquid's Brent contract on its xyz dex, as Gloom Cloud served it on 2026-10-12. */
function brent(patch: Partial<PerpBoardRow> = {}): PerpBoardRow {
  return {
    marketId: "hyperliquid:xyz:BRENTOIL", venue: "hyperliquid", dex: "xyz", symbol: "xyz:BRENTOIL", baseAsset: "BRENTOIL",
    displayName: "BRENTOIL", assetClass: "energy", underlyingSymbol: null, underlyingCurrency: null, quoteCurrency: "USDC",
    marginCurrency: "USDC", contractType: "linear", priceMultiplier: 1, markPrice: 101.43, oraclePrice: 101.7, lastPrice: null,
    previousDayPrice: 102.46, priceChange24h: -0.0100527034940463, premium: -0.0026548672566371057, venuePremium: -0.002712881,
    fundingRate: -0.0001497988, fundingIntervalHours: 1, fundingKind: "current", fundingRate8h: -0.0011983904, fundingApr: -1.312237488,
    predictedFundingRate: null, predictedFundingIntervalHours: null, nextFundingAt: null, openInterestBase: 2040521.36,
    openInterestUsd: 206970081.5448, volume24hUsd: 101610367.7818, maxLeverage: 20, isolatedOnly: false, delisted: false,
    observedAt: "2026-10-12T05:35:29.435Z", sourceAsOf: null, sourceUrl: "https://api.hyperliquid.xyz/info", confidence: "high",
    qualityFlags: [], stale: false, oiChange1h: null, oiChange24h: null, oiUsdChange1h: null, oiUsdChange24h: null, underlying: null,
    underlyingPremium: null, closedMarketPremium: null, ...patch,
  };
}
/** Binance's Brent contract: the symbol says BZ, not Brent. */
const bz = (patch: Partial<PerpBoardRow> = {}) => brent({ marketId: "binance:BZUSDT", venue: "binance", dex: "", symbol: "BZUSDT",
  baseAsset: "BZ", displayName: "BZUSDT", quoteCurrency: "USDT", marginCurrency: "USDT", previousDayPrice: null, priceChange24h: -0.00976,
  markPrice: 101.48, openInterestUsd: 232_110_000, ...patch });

const board = (rows: PerpBoardRow[], patch: Partial<PerpBoardPayload> = {}): PerpBoardPayload =>
  ({ status: "ok", asOf: "2026-10-12T05:36:12.808Z", rows, total: rows.length, locked: 0, access: "preview", ...patch });
const market = (rows: PerpBoardRow[]): PerpMarketPayload => ({ ...board(rows), evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals" });
const fakeClient = (history?: (query: PerpHistoryQuery) => PerpHistoryPayload, rows = [brent(), bz()]) => {
  const MARKETS = new Map(rows.map((row) => [row.marketId, row]));
  const boards: PerpBoardQuery[] = [];
  return {
    boards,
    getCloudPerpsMarket: async (marketId: string) => market(MARKETS.has(marketId) ? [MARKETS.get(marketId)!] : []),
    getCloudPerpsBoard: async (query: PerpBoardQuery = {}) => {
      boards.push(query);
      const search = query.search?.toUpperCase() ?? "";
      return board([...MARKETS.values()].filter((row) => `${row.symbol} ${row.baseAsset} ${row.displayName}`.toUpperCase().includes(search)));
    },
    getCloudPerpsHistory: async (query: PerpHistoryQuery) => history?.(query) ?? ({ status: "ok", marketId: query.marketId, rows: [], funding: [], candles: [],
      locked: false, access: "pro", asOf: null } satisfies PerpHistoryPayload),
  };
};

describe("perpetual markets as listings", () => {
  test("a market row quotes as its listing: mark price, the move against the price a day before, dated by its reading", () => {
    const quote = perpetualQuote(brent(), perpetualListing("XYZ-BRENTOIL:HYPERLIQUID")!)!;
    expect(quote).toMatchObject({ symbol: "XYZ-BRENTOIL:HYPERLIQUID", instrumentType: "PERP", price: 101.43, currency: "USDC",
      previousClose: 102.46, name: "Brent crude oil perpetual", listingExchangeName: "HYPERLIQUID", marketState: "REGULAR",
      lastUpdated: Date.parse("2026-10-12T05:35:29.435Z") });
    expect(quote.change).toBeCloseTo(-1.03, 6);
    expect(quote.changePercent).toBeCloseTo(-1.00527, 4);
    // A venue that sends only the 24h move still gives the change; a venue that stopped answering is stale.
    const binance = perpetualQuote(bz({ stale: true }), perpetualListing("BZUSDT:BINANCE")!)!;
    expect(binance.previousClose).toBeCloseTo(101.48 / (1 - 0.00976), 6);
    expect(binance.stale).toBe(true);
    expect(perpetualQuote(brent({ markPrice: null }), perpetualListing("XYZ-BRENTOIL:HYPERLIQUID")!)).toBeNull();
  });

  test("search finds a contract by what it tracks, not only its symbol, and a market id names its one market", async () => {
    const client = fakeClient();
    const results = await searchPerpetualMarkets("brent", client);
    // BRENTOIL holds the word; Binance's BZ is found as Brent crude oil. Larger open interest first.
    expect(results.map((result) => result.symbol)).toEqual(["BZUSDT:BINANCE", "XYZ-BRENTOIL:HYPERLIQUID"]);
    expect(results[0]).toMatchObject({ exchange: "BINANCE", type: "PERP", currency: "USDT", name: "Brent crude oil perpetual" });
    expect(client.boards.map((query) => query.search)).toContain("BZ");
    expect((await searchPerpetualMarkets("binance:BZUSDT", client)).map((result) => result.symbol)).toEqual(["BZUSDT:BINANCE"]);
    expect((await searchPerpetualMarkets("BZUSDT:BINANCE", client)).map((result) => result.symbol)).toEqual(["BZUSDT:BINANCE"]);
    expect(await searchPerpetualMarkets("SAN:EPA", client)).toEqual([]);
  });

  test("history is Pro: a free account gets what PERP says, Pro the hourly candles, in daily bars past two months", async () => {
    const listing = perpetualListing("XYZ-BRENTOIL:HYPERLIQUID")!;
    const end = new Date("2026-10-12T06:00:00Z");
    const locked = fakeClient(() => ({ status: "ok", marketId: listing.marketId, rows: [], funding: [], candles: [], locked: true, access: "preview", asOf: null }));
    await expect(getPerpetualHistory(listing, new Date("2026-10-05T06:00:00Z"), end, locked)).rejects.toThrow(PERPETUAL_HISTORY_LOCKED);

    const hours = Array.from({ length: 24 * 70 }, (_, index) => new Date(end.getTime() - (24 * 70 - index) * 3_600_000));
    const candle = (time: Date, index: number) => ({ marketId: listing.marketId, time: time.toISOString(), interval: "1h" as const, open: 100 + index,
      high: 101 + index, low: 99 + index, close: 100.5 + index, volumeBase: 10, trades: null, observedAt: time.toISOString(), sourceUrl: "" });
    const pro = fakeClient((query) => ({ status: "ok", marketId: query.marketId, rows: [], funding: [], locked: false, access: "pro", asOf: null,
      candles: hours.filter((time) => time >= new Date(query.from!)).map(candle) }));
    const week = await getPerpetualHistory(listing, new Date(end.getTime() - 7 * 86_400_000), end, pro);
    expect(week.resolution).toBe("1h");
    expect(week.points).toHaveLength(7 * 24);
    const months = await getPerpetualHistory(listing, new Date(end.getTime() - 70 * 86_400_000), end, pro);
    expect(months.resolution).toBe("1d");
    const firstDay = months.points[1]!;
    // A day's bar opens with its first hour, closes with its last and spans every hour between.
    expect(firstDay.date.toISOString()).toBe("2026-08-04T00:00:00.000Z");
    expect(firstDay.close - firstDay.open).toBe(23.5);
    expect(firstDay.high! - firstDay.low!).toBe(25);
    expect(firstDay.volume).toBe(240);
  });
});

const patched: Array<[object, string, unknown]> = [];
function patch<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
  patched.push([target, key as string, target[key]]);
  target[key] = value;
}
afterEach(() => {
  for (const [target, key, value] of patched.splice(0).reverse()) (target as Record<string, unknown>)[key] = value;
});

test("a batched search's perpetual markets are the ones each query's own search finds, read from the board once", async () => {
  const client = fakeClient();
  patch(apiClient, "getCloudPerpsBoard", client.getCloudPerpsBoard as typeof apiClient.getCloudPerpsBoard);
  patch(apiClient, "getCloudPerpsMarket", client.getCloudPerpsMarket as typeof apiClient.getCloudPerpsMarket);
  // Every query has a listing of its own; NONE has none, and is searched again alone.
  const listing = (query: string) => ({ providerId: "gloomberb-cloud", symbol: query, name: `${query} Fund`, exchange: "NYSE", type: "ETF" });
  const listings = (query: string) => query === "NONE" ? [] : [listing(query)];
  patch(apiClient, "searchInstruments", (async (query: string) => listings(query)) as typeof apiClient.searchInstruments);
  patch(apiClient, "searchInstrumentsBatch", (async (queries: readonly string[]) =>
    new Map(queries.map((query) => [query, listings(query)]))) as unknown as typeof apiClient.searchInstrumentsBatch);
  const provider = new GloomberbCloudProvider();
  const queries = ["BRENT", "BZ", "XOM", "NONE"];
  const batched = await provider.searchBatch(queries);
  const searchesOfTheBoard = client.boards.length;
  for (const query of queries.slice(0, 3)) expect(batched?.get(query)).toEqual(await provider.search(query));
  expect(batched?.get("BRENT")?.map((row) => row.symbol)).toEqual(["BZUSDT:BINANCE", "XYZ-BRENTOIL:HYPERLIQUID", "BRENT"]);
  expect(batched?.get("NONE")).toEqual([]);
  expect(searchesOfTheBoard).toBe(1);
});

test("a streamed row that leaves out a figure it does not have still quotes, the figure read as none", () => {
  const listing = perpetualListing("XYZ-BRENTOIL:HYPERLIQUID")!;
  const { premium: _premium, fundingRate8h: _funding, ...partial } = brent();
  const quote = streamedPerpetualQuote({ perpetual: partial, dataSource: "live", delivery: "stream", stale: false }, listing);
  expect(quote).toMatchObject({ price: 101.43, dataSource: "live", perpetual: { premium: null, fundingRate8h: null } });
  // A figure that is there but not a number is still refused.
  expect(streamedPerpetualQuote({ perpetual: brent({ premium: "0.1" as unknown as number }), dataSource: "live" }, listing)).toBeNull();
});

describe("the quote path", () => {
  test("a batch reads perpetuals from the PERP dataset and the rest from the quote service; the stream carries both", async () => {
    // Read a minute ago: a current price for a market that never closes.
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    const client = fakeClient(undefined, [brent({ observedAt }), bz({ observedAt })]);
    patch(apiClient, "getCloudPerpsMarket", client.getCloudPerpsMarket as typeof apiClient.getCloudPerpsMarket);
    const batched: string[][] = [];
    patch(apiClient, "getCloudQuotesBatch", (async (items: Array<{ symbol: string; exchange?: string }>) => {
      batched.push(items.map((item) => item.symbol));
      return { status: "success", data: { items: items.map((item) => ({ symbol: item.symbol, exchange: item.exchange, status: "success",
        data: { symbol: item.symbol, price: 168.94, currency: "USD", change: 0.44, changePercent: 0.26, lastUpdated: Date.now(), exchangeName: "NYSE" } })) } };
    }) as unknown as typeof apiClient.getCloudQuotesBatch);
    const streamed: string[] = [];
    let deliver: (target: { symbol: string; exchange: string }, quote: unknown) => void = () => {};
    patch(apiClient, "ensureVerifiedSession", (async () => null) as unknown as typeof apiClient.ensureVerifiedSession);
    patch(apiClient, "subscribeQuotes", ((targets: Array<{ symbol: string; exchange: string }>, onQuote: typeof deliver) => {
      streamed.push(...targets.map((target) => `${target.symbol}:${target.exchange}`));
      deliver = onQuote;
      return () => {};
    }) as unknown as typeof apiClient.subscribeQuotes);

    const router = new AssetDataRouter(null, [new GloomberbCloudProvider()]);
    router.setBackgroundRevalidation(false);
    const targets: QuoteSubscriptionTarget[] = [
      { symbol: "XYZ-BRENTOIL:HYPERLIQUID", exchange: "HYPERLIQUID" },
      { symbol: "XOM", exchange: "NYSE" },
      { symbol: "BZUSDT:BINANCE", exchange: "BINANCE" },
    ];
    const results = await router.getQuotesBatch(targets);
    expect(batched).toEqual([["XOM"]]);
    expect(results.map((result) => [result.target.symbol, result.quote?.instrumentType === "PERP" ? result.quote.price : "listing"])).toEqual([
      ["XYZ-BRENTOIL:HYPERLIQUID", 101.43],
      ["XOM", "listing"],
      ["BZUSDT:BINANCE", 101.48],
    ]);
    // The stream carries a contract as its listing on its venue, and answers with the market's row.
    const quotes: Array<[string, unknown]> = [];
    new GloomberbCloudProvider().subscribeQuotes(targets, (target, quote) => quotes.push([target.symbol, quote]))();
    expect(streamed).toEqual(["XOM:NYSE", "XYZ-BRENTOIL:HYPERLIQUID", "BZUSDT:BINANCE"]);
    const live = bz({ observedAt: new Date().toISOString(), markPrice: 102.01, fundingRate8h: 0.0002 });
    deliver({ symbol: "BZUSDT", exchange: "BINANCE" }, { symbol: "BZUSDT", price: 102.01, delivery: "stream", dataSource: "live", perpetual: live });
    // A frame whose row is another market's is not this contract's quote.
    deliver({ symbol: "XYZ-BRENTOIL", exchange: "HYPERLIQUID" }, { symbol: "XYZ-BRENTOIL", price: 1, delivery: "stream", perpetual: live });
    expect(quotes).toEqual([["BZUSDT:BINANCE", {
      ...perpetualQuote(live, perpetualListing("BZUSDT:BINANCE")!), dataSource: "live", delivery: "stream", perpetual: live,
    }]]);
  });
});
