import { afterEach, describe, expect, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { PerpBoardPayload, PerpBoardQuery, PerpBoardRow, PerpHistoryPayload, PerpHistoryQuery, PerpMarketPayload } from "../../api-client/perps";
import { perpetualListing } from "../../tickers/perpetual-listing";
import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import { AssetDataRouter } from "../provider-router";
import { GloomberbCloudProvider } from "./index";
import { getPerpetualHistory, PERPETUAL_HISTORY_LOCKED, PerpetualBoardCache, perpetualQuote, searchPerpetualMarkets, streamedPerpetualQuote } from "./perpetuals";

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
    // A signed-out search is the preview board's rows that hold the word: one read of it serves the search and its alias.
    expect(client.boards).toEqual([{}]);
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

test("a signed-out account reads the board once for every one-word search, and a signed-in account's searches go to the service", async () => {
  const signedOut = fakeClient();
  const boards = new PerpetualBoardCache();
  expect((await searchPerpetualMarkets("brent", signedOut, boards)).map((row) => row.symbol)).toEqual(["BZUSDT:BINANCE", "XYZ-BRENTOIL:HYPERLIQUID"]);
  expect((await searchPerpetualMarkets("bz", signedOut, boards)).map((row) => row.symbol)).toEqual(["BZUSDT:BINANCE"]);
  expect(await searchPerpetualMarkets("nvda", signedOut, boards)).toEqual([]);
  expect(signedOut.boards).toEqual([{}]);
  // The board is kept by the cache a provider holds, not by the process: a cache of its own reads it again.
  await searchPerpetualMarkets("bz", signedOut, new PerpetualBoardCache());
  expect(signedOut.boards).toEqual([{}, {}]);
  // Words the service reads as it likes are asked of it.
  const phrase = fakeClient();
  await searchPerpetualMarkets("brent oil", phrase);
  expect(phrase.boards.map((query) => query.search)).toContain("brent oil");
  // The whole board of a signed-in account is not read for one word.
  const signedIn = { ...fakeClient(), hasSessionCredential: () => true };
  expect((await searchPerpetualMarkets("bz", signedIn)).map((row) => row.symbol)).toEqual(["BZUSDT:BINANCE"]);
  expect(signedIn.boards).toEqual([{ search: "bz" }]);
});

test("the board kept for searches is the one read for whoever is asking, in both directions of signing in and out", async () => {
  // A signed-out account is shown a preview; the rows it leaves out are the ones a Pro account is shown.
  const preview = [brent(), bz()];
  const full = [...preview, brent({ marketId: "binance:NVDAUSDT", venue: "binance", dex: "", symbol: "NVDAUSDT", baseAsset: "NVDA", displayName: "NVDAUSDT" })];
  let session: string | null = null;
  const reads: Array<string | null> = [];
  const client = {
    ...fakeClient(),
    hasSessionCredential: () => session !== null,
    getSessionToken: () => session,
    getCloudPerpsBoard: async () => { reads.push(session); return board(session ? full : preview); },
  };
  const boards = new PerpetualBoardCache();
  const symbols = async () => (await boards.read(client)).rows.map((row) => row.baseAsset);
  expect(await symbols()).toEqual(["BRENTOIL", "BZ"]);
  expect(await symbols()).toEqual(["BRENTOIL", "BZ"]);
  expect(reads).toEqual([null]);
  // Signed in: the preview kept for the signed-out account is not what a search is answered from.
  session = "token-a";
  expect(await symbols()).toEqual(["BRENTOIL", "BZ", "NVDA"]);
  expect(await symbols()).toEqual(["BRENTOIL", "BZ", "NVDA"]);
  expect(reads).toEqual([null, "token-a"]);
  // Signed out again: the full board kept for the account is not shown to one that is not.
  session = null;
  expect(await symbols()).toEqual(["BRENTOIL", "BZ"]);
  expect(reads).toEqual([null, "token-a", null]);
  // Another account has a board of its own.
  session = "token-a";
  await symbols();
  session = "token-b";
  await symbols();
  expect(reads).toEqual([null, "token-a", null, "token-a", "token-b"]);
});

test("a provider's searches do not take a board from the other side of a sign-in", async () => {
  let session: string | null = null;
  const reads: Array<string | null> = [];
  const hidden = brent({ marketId: "binance:NVDAUSDT", venue: "binance", dex: "", symbol: "NVDAUSDT", baseAsset: "NVDA", displayName: "NVDAUSDT" });
  const rowsFor = () => session ? [brent(), bz(), hidden] : [brent(), bz()];
  patch(apiClient, "hasSessionCredential", () => session !== null);
  patch(apiClient, "getSessionToken", () => session);
  patch(apiClient, "getCloudPerpsBoard", (async (query: PerpBoardQuery = {}) => {
    reads.push(session);
    const search = query.search?.toUpperCase() ?? "";
    return board(rowsFor().filter((row) => `${row.symbol} ${row.baseAsset} ${row.displayName}`.toUpperCase().includes(search)));
  }) as typeof apiClient.getCloudPerpsBoard);
  patch(apiClient, "getCloudPerpsMarket", fakeClient().getCloudPerpsMarket as typeof apiClient.getCloudPerpsMarket);
  const listing = (query: string) => ({ providerId: "gloomberb-cloud", symbol: query, name: `${query} Fund`, exchange: "NYSE", type: "ETF" });
  patch(apiClient, "searchInstruments", (async (query: string) => [listing(query)]) as typeof apiClient.searchInstruments);
  patch(apiClient, "searchInstrumentsBatch", (async (queries: readonly string[]) =>
    new Map(queries.map((query) => [query, [listing(query)]]))) as unknown as typeof apiClient.searchInstrumentsBatch);
  const provider = new GloomberbCloudProvider();
  const contracts = async () => (await provider.searchBatch(["NVDA"]))?.get("NVDA")?.map((row) => row.symbol);
  expect(await contracts()).toEqual(["NVDA"]);
  session = "token-a";
  expect(await contracts()).toEqual(["NVDAUSDT:BINANCE", "NVDA"]);
  session = null;
  expect(await contracts()).toEqual(["NVDA"]);
  expect(reads).toEqual([null, "token-a", null]);
});

test("a lookup asks for perpetual markets beside the listings, and not at all for a symbol known to be a US stock", async () => {
  const client = fakeClient([brent(), bz()].map((row) => row), [brent(), bz(), brent({ marketId: "binance:NVDAUSDT", venue: "binance", dex: "", symbol: "NVDAUSDT", baseAsset: "NVDA", displayName: "NVDAUSDT" })]);
  patch(apiClient, "getCloudPerpsBoard", client.getCloudPerpsBoard as typeof apiClient.getCloudPerpsBoard);
  patch(apiClient, "getCloudPerpsMarket", client.getCloudPerpsMarket as typeof apiClient.getCloudPerpsMarket);
  const rows: Record<string, InstrumentSearchResult[]> = {
    NVDA: [{ providerId: "gloomberb-cloud", symbol: "NVDA", name: "NVIDIA Corporation", exchange: "NASDAQ", type: "Common Stock" }],
    BRENT: [{ providerId: "gloomberb-cloud", symbol: "BRENT", name: "Brent Fund", exchange: "NYSE", type: "ETF" }],
  };
  let release: () => void = () => {};
  const listed = new Promise<void>((resolve) => { release = resolve; });
  patch(apiClient, "searchInstruments", (async (query: string) => { await listed; return rows[query.toUpperCase()] ?? []; }) as typeof apiClient.searchInstruments);
  const provider = new GloomberbCloudProvider();
  provider.knownUsStock = (symbol) => symbol === "NVDA";
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // A fund, a symbol nothing lists or a coin: the board is asked for with the listings, not after them.
  const fund = provider.search("BRENT");
  await tick();
  expect(client.boards).toEqual([{}]);
  // The stock NVDA: nothing is asked for beside its listings.
  const stock = provider.search("NVDA");
  await tick();
  expect(client.boards).toEqual([{}]);
  release();
  expect((await fund).map((row) => row.symbol)).toEqual(["BZUSDT:BINANCE", "XYZ-BRENTOIL:HYPERLIQUID", "BRENT"]);
  expect((await stock).map((row) => row.symbol)).toEqual(["NVDA"]);
  // The search a person types, and the command bar, keep the contracts for a stock; the board is read once.
  expect((await provider.search("NVDA", { perpetuals: "always" })).map((row) => row.symbol)).toEqual(["NVDAUSDT:BINANCE", "NVDA"]);
  expect((await provider.search("NVDA", { interactive: true })).map((row) => row.symbol)).toEqual(["NVDAUSDT:BINANCE", "NVDA"]);
  expect(client.boards).toEqual([{}]);
  // Without a command line's list of stocks, every lookup asks.
  provider.knownUsStock = undefined;
  expect((await provider.search("NVDA")).map((row) => row.symbol)).toEqual(["NVDAUSDT:BINANCE", "NVDA"]);
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

test("a listing's name loses the stray code a venue's fixed-width file leaves after its spaces, alone or in a batch", async () => {
  const client = fakeClient();
  patch(apiClient, "getCloudPerpsBoard", client.getCloudPerpsBoard as typeof apiClient.getCloudPerpsBoard);
  const rows = () => [
    { providerId: "gloomberb-cloud", symbol: "YAR", name: "Americold Realty Trust Inc.   R", exchange: "HANOVER", type: "Common Stock" },
    { providerId: "gloomberb-cloud", symbol: "YAR", name: "Yara International  ASA", exchange: "OSL", type: "Common Stock" },
  ];
  patch(apiClient, "searchInstruments", (async () => rows()) as unknown as typeof apiClient.searchInstruments);
  patch(apiClient, "searchInstrumentsBatch", (async (queries: readonly string[]) =>
    new Map(queries.map((query) => [query, rows()]))) as unknown as typeof apiClient.searchInstrumentsBatch);
  const provider = new GloomberbCloudProvider();
  // Only a one-letter code after a run of spaces is stray; a word after two spaces is the name's, kept with one space.
  const names = ["Americold Realty Trust Inc.", "Yara International ASA"];
  expect((await provider.search("YAR")).filter((row) => row.symbol === "YAR").map((row) => row.name)).toEqual(names);
  expect((await provider.searchBatch(["YAR"]))?.get("YAR")?.filter((row) => row.symbol === "YAR").map((row) => row.name)).toEqual(names);
});
