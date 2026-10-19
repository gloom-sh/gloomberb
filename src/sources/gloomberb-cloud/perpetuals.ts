import { apiClient } from "../../api-client";
import type { PerpBoardPayload, PerpBoardRow, PerpMarketPayload } from "../../api-client/perps";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { PricePoint, Quote } from "../../types/financials";
import type { PriceHistoryResult } from "../../types/price-history";
import {
  PERPETUAL_TYPE,
  perpetualListing,
  perpetualListingOfMarket,
  perpetualMarketIds,
  perpetualVenueName,
  typedPerpetualListing,
  type PerpetualListing,
} from "../../tickers/perpetual-listing";
import { createProviderMiss } from "../provider-errors";
import { GLOOMBERB_CLOUD_PROVIDER_ID } from "./normalizers";

/**
 * Perpetual markets as listings on Gloom Cloud: a contract saved as
 * `BZUSDT:BINANCE` is quoted, searched and charted from the PERP dataset
 * through the same provider calls as a stock, so watchlists, `quote` and
 * charts read it like any other listing. Latest values of one market are free;
 * its history is Pro, as in PERP.
 */

type PerpsClient = Pick<typeof apiClient, "getCloudPerpsMarket" | "getCloudPerpsBoard" | "getCloudPerpsHistory">;

/** What the history of a perpetual says to a free account, as PERP's History tab does. */
export const PERPETUAL_HISTORY_LOCKED = "Full history requires Gloom Pro.";

/** The perpetual market a listing names; null for a listing on another venue. */
export function perpetualTarget(symbol: string, exchange?: string): PerpetualListing | null {
  return perpetualListing(symbol, exchange);
}

/**
 * Plain names for contracts whose symbol does not say what they track
 * (Binance's BZ is Brent), by asset class so a coin of the same ticker keeps
 * its own name. Search matches these words as well as the symbol.
 */
const PLAIN_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  energy: {
    BRENTOIL: "Brent crude oil", BRENT: "Brent crude oil", BZ: "Brent crude oil", UKOIL: "Brent crude oil",
    CL: "WTI crude oil", WTI: "WTI crude oil", USOIL: "WTI crude oil", WTIOIL: "WTI crude oil", OIL: "Crude oil",
    NATGAS: "Natural gas", NG: "Natural gas", GAS: "Natural gas", TTF: "Dutch TTF natural gas", HO: "Heating oil",
    URANIUM: "Uranium",
  },
  metals: {
    GOLD: "Gold", XAU: "Gold", SILVER: "Silver", XAG: "Silver", COPPER: "Copper", XCU: "Copper",
    PLATINUM: "Platinum", XPT: "Platinum", PALLADIUM: "Palladium", XPD: "Palladium", ALUMINIUM: "Aluminium", ALUMINUM: "Aluminium",
  },
};

/** "Brent crude oil perpetual", "BTC perpetual": what the contract tracks, in words where its symbol does not say. */
function perpetualName(row: Pick<PerpBoardRow, "baseAsset" | "assetClass">): string {
  const base = row.baseAsset.toUpperCase();
  return `${PLAIN_NAMES[row.assetClass]?.[base] ?? row.baseAsset} perpetual`;
}

/** The listing a market row is saved under; null for a venue the app has no listing code for. */
function rowListing(row: PerpBoardRow): PerpetualListing | null {
  return perpetualListingOfMarket(row.marketId);
}

/**
 * The market's latest values, from the first of its ids Gloom Cloud knows.
 * A free account reads them as PERP shows one market. Null when no venue
 * lists it.
 */
export async function loadPerpetualMarket(
  listing: PerpetualListing,
  client: Pick<PerpsClient, "getCloudPerpsMarket"> = apiClient,
): Promise<{ row: PerpBoardRow; payload: PerpMarketPayload } | null> {
  for (const marketId of perpetualMarketIds(listing)) {
    const payload = await client.getCloudPerpsMarket(marketId);
    const row = Array.isArray(payload?.rows) ? payload.rows.find((candidate) => candidate?.marketId === marketId) : undefined;
    if (row) return { row, payload };
  }
  return null;
}

/**
 * A market row as a quote: its mark price, the move over the venue's last
 * 24 hours against the price a day before, dated by when the venue was read.
 * The contract trades around the clock, so its market is always open; a
 * venue that stopped answering for it leaves the quote stale.
 */
export function perpetualQuote(row: PerpBoardRow, listing: PerpetualListing): Quote | null {
  const price = row.markPrice ?? row.lastPrice;
  const observed = Date.parse(row.observedAt);
  if (price == null || !Number.isFinite(price) || !Number.isFinite(observed)) return null;
  const change24h = row.priceChange24h;
  const previous = row.previousDayPrice != null && row.previousDayPrice > 0 ? row.previousDayPrice
    : change24h != null && change24h > -1 ? price / (1 + change24h) : undefined;
  const change = previous != null ? price - previous : 0;
  const changePercent = change24h != null ? change24h * 100 : previous ? (change / previous) * 100 : 0;
  const venue = perpetualVenueName(listing.exchange) ?? listing.exchange;
  return {
    symbol: listing.key,
    instrumentType: PERPETUAL_TYPE,
    providerId: GLOOMBERB_CLOUD_PROVIDER_ID,
    price,
    currency: row.quoteCurrency,
    change,
    changePercent,
    ...(previous != null ? { previousClose: previous } : {}),
    name: perpetualName(row),
    lastUpdated: observed,
    exchangeName: listing.exchange,
    fullExchangeName: venue,
    listingExchangeName: listing.exchange,
    listingExchangeFullName: venue,
    marketState: "REGULAR",
    // Read from the venue about once a minute, as PERP's footer says: not a live feed.
    dataSource: "delayed",
    ...(row.markPrice != null ? { mark: row.markPrice } : {}),
    ...(row.lastPrice != null ? { lastTradePrice: row.lastPrice } : {}),
    ...(row.stale || row.delisted ? { stale: true } : {}),
  };
}

/** The quote of a perpetual listing; a miss when no venue lists the market or it has no price. */
export async function getPerpetualQuote(listing: PerpetualListing, client: Pick<PerpsClient, "getCloudPerpsMarket"> = apiClient): Promise<Quote> {
  const market = await loadPerpetualMarket(listing, client);
  const quote = market ? perpetualQuote(market.row, listing) : null;
  if (!quote) throw createProviderMiss(`Not a ticker: ${listing.key}.`, undefined, { notFound: true });
  return quote;
}

function searchResult(row: PerpBoardRow): InstrumentSearchResult | null {
  const listing = rowListing(row);
  if (!listing) return null;
  return {
    providerId: GLOOMBERB_CLOUD_PROVIDER_ID,
    symbol: listing.key,
    name: perpetualName(row),
    exchange: listing.exchange,
    type: PERPETUAL_TYPE,
    currency: row.quoteCurrency,
  };
}

/**
 * A client whose board searches are answered from one copy of the board, as
 * the board answers them: its rows whose symbol, base asset or name holds the
 * words, in its order. The board read without a search is the one a search
 * reads (all of it with Pro, its preview without), so a list's searches cost
 * one board request and find what each would find alone.
 */
export function boardSearchesFrom(board: PerpBoardPayload, client: PerpsClient = apiClient): PerpsClient {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  return {
    getCloudPerpsMarket: client.getCloudPerpsMarket,
    getCloudPerpsHistory: client.getCloudPerpsHistory,
    getCloudPerpsBoard: async ({ search } = {}) => {
      const wanted = search?.trim().toUpperCase();
      return { ...board, rows: wanted ? rows.filter((row) => `${row.symbol} ${row.baseAsset} ${row.displayName}`.toUpperCase().includes(wanted)) : rows };
    },
  };
}

/** The one market a query names by its market id or listing key; null for a search. */
const namedListing = (query: string) => typedPerpetualListing(query) ?? (query.includes(":") ? perpetualListing(query) : null);

/** Whether a search names one perpetual market (`binance:BZUSDT`, `BZUSDT:BINANCE`) rather than looking for some. */
export const namesPerpetualMarket = (query: string) => namedListing(query.trim()) !== null;

const PERPETUAL_WORDS = /\b(perps?|perpetuals?|swaps?)\b/gi;
const MAX_SEARCH_RESULTS = 6;
const MAX_ALIAS_SEARCHES = 3;

/**
 * Perpetual markets a search finds: a market id or listing key names its one
 * market; any other query is matched by the board's search on the contract's
 * symbol and on the plain names above ("brent" finds Binance's BZ as well as
 * Hyperliquid's BRENTOIL). A free account searches the board's preview, as
 * PERP's own search does, but can still name any one market.
 */
export async function searchPerpetualMarkets(query: string, client: PerpsClient = apiClient): Promise<InstrumentSearchResult[]> {
  const trimmed = query.trim();
  const named = namedListing(trimmed);
  if (named) {
    const market = await loadPerpetualMarket(named, client);
    const result = market ? searchResult(market.row) : null;
    return result ? [result] : [];
  }
  if (trimmed.includes(":")) return [];
  const words = trimmed.replace(PERPETUAL_WORDS, " ").trim().replace(/\s+/g, " ");
  if (words.length < 2 || !/^[\p{L}\p{N} .&-]+$/u.test(words)) return [];
  const wanted = words.toUpperCase();
  const queryWords = wanted.split(" ");
  // The plain names a query is part of: "brent" is in Brent crude oil, which Binance's contract is BZ. A symbol
  // holding the query already answers the board's own search.
  const aliases = Object.entries(PLAIN_NAMES).flatMap(([assetClass, names]) => Object.entries(names)
    .filter(([symbol, name]) => {
      const nameWords = name.toUpperCase().split(/\s+/);
      return !symbol.includes(wanted) && queryWords.every((word) => nameWords.some((nameWord) => nameWord.startsWith(word)));
    })
    .map(([symbol]) => ({ assetClass, symbol })));
  const searches = [
    { search: words, keep: (_row: PerpBoardRow) => true },
    ...aliases.slice(0, MAX_ALIAS_SEARCHES).map(({ assetClass, symbol }) => ({
      search: symbol,
      keep: (row: PerpBoardRow) => row.assetClass === assetClass && row.baseAsset.toUpperCase() === symbol,
    })),
  ];
  const boards = await Promise.all(searches.map(async ({ search, keep }) => {
    const board = await client.getCloudPerpsBoard({ search });
    return (Array.isArray(board?.rows) ? board.rows : []).filter((row) => !row.delisted && keep(row));
  }));
  const seen = new Set<string>();
  const rows = boards.flat().filter((row) => !seen.has(row.marketId) && !!seen.add(row.marketId))
    // The board orders each search by open interest; keep that across searches.
    .sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0));
  return rows.flatMap((row) => searchResult(row) ?? []).slice(0, MAX_SEARCH_RESULTS);
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Longer ranges are drawn in daily bars made from the hourly ones. */
const HOURLY_RANGE_MS = 60 * DAY_MS;

function dailyBars(points: PricePoint[]): PricePoint[] {
  const days = new Map<number, PricePoint>();
  for (const point of points) {
    const day = Math.floor(point.date.getTime() / DAY_MS) * DAY_MS;
    const bar = days.get(day);
    if (!bar) {
      days.set(day, { ...point, date: new Date(day) });
      continue;
    }
    bar.high = Math.max(bar.high ?? bar.close, point.high ?? point.close);
    bar.low = Math.min(bar.low ?? bar.close, point.low ?? point.close);
    bar.close = point.close;
    if (point.volume != null) bar.volume = (bar.volume ?? 0) + point.volume;
  }
  return [...days.values()];
}

/**
 * A perpetual's price history between two times: the venue's hourly candles,
 * or Gloom's own mark observations where the venue gives none, in daily bars
 * past two months. Pro only; a free account's request fails with what PERP
 * says, and a market without collected history yet is an empty answer.
 */
export async function getPerpetualHistory(
  listing: PerpetualListing,
  start: Date,
  end: Date,
  client: Pick<PerpsClient, "getCloudPerpsHistory" | "getCloudPerpsMarket"> = apiClient,
): Promise<PriceHistoryResult> {
  const market = await loadPerpetualMarket(listing, client);
  if (!market) throw createProviderMiss(`Not a ticker: ${listing.key}.`, undefined, { notFound: true });
  const history = await client.getCloudPerpsHistory({
    marketId: market.row.marketId, from: start.toISOString(), to: end.toISOString(), resolution: "auto", limit: 5000,
  });
  if (history.locked) throw createProviderMiss(PERPETUAL_HISTORY_LOCKED, PERPETUAL_HISTORY_LOCKED);
  const candles: PricePoint[] = (history.candles ?? []).filter((candle) => Number.isFinite(Date.parse(candle.time)))
    .map((candle) => ({ date: new Date(candle.time), open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      ...(candle.volumeBase != null ? { volume: candle.volumeBase } : {}) }));
  const marks: PricePoint[] = (history.rows ?? []).filter((row) => row.markPrice != null && Number.isFinite(Date.parse(row.time)))
    .map((row) => ({ date: new Date(row.time), close: row.markPrice! }));
  const hourly = candles.length > 0 ? candles : marks;
  const daily = end.getTime() - start.getTime() > HOURLY_RANGE_MS;
  const points = (daily ? dailyBars(hourly) : hourly).sort((a, b) => a.date.getTime() - b.date.getTime());
  const intervalMs = points.length > 1 ? points[1]!.date.getTime() - points[0]!.date.getTime() : 0;
  return { points, resolution: daily ? "1d" : candles.length > 0 || intervalMs >= HOUR_MS ? "1h" : null };
}
