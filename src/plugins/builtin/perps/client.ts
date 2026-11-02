import { apiClient } from "../../../api-client";
import type { PerpBoardPayload, PerpBoardQuery, PerpBoardRow, PerpDepthPayload, PerpDepthSnapshot, PerpEquitiesPayload, PerpEquityListing, PerpHistoryPayload, PerpHistoryQuery,
  PerpLiquidationsPayload, PerpLongShortPoint, PerpLongShortRatio, PerpMarketPayload, PerpRankingsPayload } from "../../../api-client/perps";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";
import { baseOfLabel, marketLabel, perpBaseCandidates, separatedPairBase } from "./model";

export const perpsCache = createPluginCache<PerpBoardPayload>({ kind: "perps-board", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
export const perpsHistoryCache = createPluginCache<PerpHistoryPayload>({ kind: "perps-history", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
const finiteOrNull = (n: unknown) => n === null || typeof n === "number" && Number.isFinite(n);
const date = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));
const share = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
/** A long/short reading: shares within 0..1, a finite ratio or none. Older servers send no reading at all. */
const validShares = (value: Pick<PerpLongShortPoint, "longShare" | "shortShare" | "ratio" | "derived" | "definition" | "observedAt">) =>
  share(value.longShare) && share(value.shortShare) && finiteOrNull(value.ratio) && typeof value.derived === "boolean" && typeof value.definition === "string" && date(value.observedAt);
const validLongShort = (value: PerpLongShortRatio | null | undefined) => value == null
  || typeof value === "object" && validShares(value) && typeof value.venue === "string" && typeof value.definitionText === "string" && date(value.bucketAt) && typeof value.stale === "boolean";
function validRow(row: PerpBoardRow) {
  return !!row && typeof row.marketId === "string" && typeof row.symbol === "string" && typeof row.displayName === "string"
    && typeof row.baseAsset === "string" && typeof row.quoteCurrency === "string" && typeof row.marginCurrency === "string"
    && date(row.observedAt) && typeof row.sourceUrl === "string" && Array.isArray(row.qualityFlags)
    && [row.markPrice, row.oraclePrice, row.fundingRate, row.fundingIntervalHours, row.fundingRate8h, row.fundingApr,
      row.predictedFundingRate, row.predictedFundingIntervalHours, row.openInterestBase, row.openInterestUsd, row.volume24hUsd,
      row.premium, row.oiChange24h, row.closedMarketPremium].every(finiteOrNull)
    && (row.fundingIntervalHours === null || row.fundingIntervalHours > 0)
    && validLongShort(row.longShortRatio) && (row.longShortRatioReason == null || typeof row.longShortRatioReason === "string");
}
function envelope(data: { access: string; locked: number | boolean; asOf: string | null }) {
  return !!data && ["pro", "preview"].includes(data.access) && (typeof data.locked === "boolean" || Number.isInteger(data.locked) && data.locked >= 0) && (data.asOf === null || date(data.asOf));
}
export function validatePerpsBoard(data: PerpBoardPayload): PerpBoardPayload {
  if (!envelope(data) || !Array.isArray(data.rows) || !data.rows.every(validRow)
    || new Set(data.rows.map((row) => row.marketId)).size !== data.rows.length) throw new Error("The server returned unreadable perpetual markets");
  return data;
}
export function validatePerpsHistory(data: PerpHistoryPayload, expectedMarketId?: string): PerpHistoryPayload {
  if (!envelope(data) || typeof data.marketId !== "string" || expectedMarketId !== undefined && data.marketId !== expectedMarketId || !Array.isArray(data.rows) || !Array.isArray(data.funding) || !Array.isArray(data.candles)
    || !data.rows.every((row) => date(row.time) && [row.markPrice, row.oraclePrice, row.premium, row.fundingRate, row.fundingIntervalHours, row.openInterestBase, row.openInterestUsd].every(finiteOrNull) && (row.fundingIntervalHours === null || row.fundingIntervalHours > 0))
    || !data.funding.every((row) => date(row.time) && typeof row.rate === "number" && Number.isFinite(row.rate) && Number.isFinite(row.intervalHours) && row.intervalHours > 0 && row.marketId === data.marketId && date(row.observedAt) && typeof row.sourceUrl === "string")
    || !data.candles.every((row) => date(row.time) && [row.open, row.high, row.low, row.close].every((n) => typeof n === "number" && Number.isFinite(n)) && row.marketId === data.marketId && date(row.observedAt) && typeof row.sourceUrl === "string")
    || data.longShortRatio != null && !(Array.isArray(data.longShortRatio) && data.longShortRatio.every((point) => !!point && date(point.time) && validShares(point)))) throw new Error("The server returned unreadable perpetual history");
  return data;
}
export const fetchPerpsHistory = async (query: PerpHistoryQuery, client: Pick<typeof apiClient, "getCloudPerpsHistory"> = apiClient) => validatePerpsHistory(await client.getCloudPerpsHistory(query), query.marketId);

const RANKING_KEYS = ["fundingPositive", "fundingNegative", "oiSurges", "premiumDislocations", "closedMarketDislocations"] as const;
export function validatePerpsRankings(data: PerpRankingsPayload): PerpRankingsPayload {
  // A market can rank in several lists, but only once in each.
  if (!envelope(data) || !RANKING_KEYS.every((key) => Array.isArray(data[key]) && data[key].every(validRow)
    && new Set(data[key].map((row) => row.marketId)).size === data[key].length)) throw new Error("The server returned unreadable perpetual rankings");
  return data;
}
/**
 * The server ranks by its own figures and has no long-share order. A full board (Pro) and the fixed preview
 * both arrive whole, so ordering them here is the order the server would give: highest first, none last.
 */
const LONG_SHORT_SORT = "long-short";
const byLongShare = (rows: readonly PerpBoardRow[]) => [...rows].sort((a, b) =>
  (b.longShortRatio?.longShare ?? -Infinity) - (a.longShortRatio?.longShare ?? -Infinity) || a.marketId.localeCompare(b.marketId));
export async function fetchPerpsBoard(query: PerpBoardQuery, client: Pick<typeof apiClient, "getCloudPerpsBoard"> = apiClient) {
  if (query.sort !== LONG_SHORT_SORT) return validatePerpsBoard(await client.getCloudPerpsBoard(query));
  const data = validatePerpsBoard(await client.getCloudPerpsBoard({ ...query, sort: "oi" }));
  return { ...data, rows: byLongShare(data.rows) };
}
export const fetchPerpsRankings = async (client: Pick<typeof apiClient, "getCloudPerpsRankings"> = apiClient) => validatePerpsRankings(await client.getCloudPerpsRankings());
/** The base assets a comparison asked for `baseAsset` may hold: itself, or what a pair or plain name (BTC-USD, bitcoin) stands for. */
const comparedBases = (baseAsset: string) => new Set([baseAsset, ...perpBaseCandidates(baseAsset).map(baseOfLabel)].map((base) => base.toUpperCase()));
function validatePerpsCompare(data: PerpBoardPayload, baseAsset: string): PerpBoardPayload {
  validatePerpsBoard(data);
  const bases = comparedBases(baseAsset);
  if (!data.rows.every((row) => bases.has(row.baseAsset.toUpperCase()))) throw new Error("The server returned contracts for another asset");
  return data;
}
/**
 * One asset across venues. A name the venues do not list as typed (BTC-USD, bitcoin, brent) is read as the base asset
 * it stands for, nearest first; the rows say which one answered.
 */
export async function fetchPerpsCompare(baseAsset: string, client: Pick<typeof apiClient, "getCloudPerpsCompare"> = apiClient): Promise<PerpBoardPayload> {
  const direct = validatePerpsCompare(await client.getCloudPerpsCompare(baseAsset), baseAsset);
  if (direct.rows.length || direct.locked) return direct;
  for (const base of perpBaseCandidates(baseAsset).map(baseOfLabel)) {
    const found = validatePerpsCompare(await client.getCloudPerpsCompare(base), base);
    if (found.rows.length || found.locked) return found;
  }
  return direct;
}
export const perpsRankingsCache = createPluginCache<PerpRankingsPayload>({ kind: "perps-rankings", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
// Board and comparison payloads share the board cache, keyed by the query and the account's plan.
const boardKey = (query: PerpBoardQuery, access: string) => `board:v1:${query.assetClass ?? "all"}:${query.sort ?? "oi"}:${query.search?.trim().toUpperCase() ?? ""}:${access}`;
export const cachedPerpsBoard = (query: PerpBoardQuery, access: string) => cachedCloudResource(perpsCache, boardKey(query, access), validatePerpsBoard);
export const loadPerpsBoard = (query: PerpBoardQuery, access: string, force = false) => loadCloudResource(perpsCache, boardKey(query, access), () => fetchPerpsBoard(query), { force, validate: validatePerpsBoard });
export const cachedPerpsRankings = (access: string) => cachedCloudResource(perpsRankingsCache, `rankings:v1:${access}`, validatePerpsRankings);
export const loadPerpsRankings = (access: string, force = false) => loadCloudResource(perpsRankingsCache, `rankings:v1:${access}`, () => fetchPerpsRankings(), { force, validate: validatePerpsRankings });
const compareKey = (baseAsset: string, access: string) => `compare:v1:${baseAsset.toUpperCase()}:${access}`;
export const cachedPerpsCompare = (baseAsset: string, access: string) => cachedCloudResource(perpsCache, compareKey(baseAsset, access), (data) => validatePerpsCompare(data, baseAsset));
export const loadPerpsCompare = (baseAsset: string, access: string, force = false) => loadCloudResource(perpsCache, compareKey(baseAsset, access), () => fetchPerpsCompare(baseAsset), { force, validate: (data) => validatePerpsCompare(data, baseAsset) });
// Liquidations and order book depth of one base asset. Older servers answer 404, which the tab shows as its error.
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const nonNegative = (n: unknown) => finite(n) && (n as number) >= 0;
const strings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const cascadeEnvelope = (data: { access: string; locked: boolean; asOf: string; baseAsset: string; notes: unknown }) =>
  !!data && ["pro", "preview"].includes(data.access) && typeof data.locked === "boolean" && date(data.asOf) && typeof data.baseAsset === "string" && strings(data.notes);
const named = (row: { marketId: string; venue: string; symbol: string }) => !!row && typeof row.marketId === "string" && typeof row.venue === "string" && typeof row.symbol === "string";
const TOTALS = ["long24h", "short24h", "long7d", "short7d", "count24h", "count7d"] as const;
export function validatePerpsLiquidations(data: PerpLiquidationsPayload): PerpLiquidationsPayload {
  if (!cascadeEnvelope(data) || !date(data.from) || !(data.collectingSince === null || date(data.collectingSince)) || !data.totals || !TOTALS.every((key) => nonNegative(data.totals[key]))
    || !Array.isArray(data.markets) || !data.markets.every((row) => named(row) && TOTALS.every((key) => nonNegative(row[key])) && (row.lastEventAt === null || date(row.lastEventAt)))
    || new Set(data.markets.map((row) => row.marketId)).size !== data.markets.length
    || !Array.isArray(data.hourly) || !data.hourly.every((hour) => !!hour && date(hour.time) && nonNegative(hour.long) && nonNegative(hour.short) && nonNegative(hour.count))
    || !Array.isArray(data.largest) || !data.largest.every((print) => named(print) && (print.side === "long" || print.side === "short") && (print.priceKind === "fill" || print.priceKind === "bankruptcy")
      && [print.price, print.quantity, print.notionalUsd].every(nonNegative) && date(print.eventAt) && date(print.receivedAt))
    || !Array.isArray(data.streams) || !data.streams.every((stream) => !!stream && typeof stream.venue === "string" && (stream.state === "live" || stream.state === "down")))
    throw new Error("The server returned unreadable perpetual liquidations");
  return data;
}
const BANDS = ["bid05", "ask05", "bid1", "ask1", "bid2", "ask2"] as const;
const validSnapshot = (row: PerpDepthSnapshot) => !!row && typeof row.marketId === "string" && date(row.bucket) && date(row.observedAt) && (row.sourceAsOf === null || date(row.sourceAsOf))
  && finite(row.mid) && row.mid > 0 && BANDS.every((band) => nonNegative(row[band])) && nonNegative(row.bidReach) && nonNegative(row.askReach) && finite(row.levels) && (row.grouping === null || finite(row.grouping));
export function validatePerpsDepth(data: PerpDepthPayload): PerpDepthPayload {
  if (!cascadeEnvelope(data) || !Array.isArray(data.rows) || !data.rows.every((row) => validSnapshot(row) && named(row) && typeof row.stale === "boolean")
    || new Set(data.rows.map((row) => row.marketId)).size !== data.rows.length
    || !Array.isArray(data.history) || !data.history.every(validSnapshot) || !Array.isArray(data.sources)) throw new Error("The server returned unreadable order book depth");
  return data;
}
/** A name the venues do not list as typed (ETH-USD, bitcoin) is read as the base asset it stands for, as Compare reads it. */
async function byBaseAsset<T extends { markets?: unknown[]; rows?: unknown[] }>(baseAsset: string, fetch: (base: string) => Promise<T>): Promise<T> {
  const listed = (data: T) => (data.markets ?? data.rows ?? []).length > 0;
  const direct = await fetch(baseAsset);
  if (listed(direct)) return direct;
  for (const base of perpBaseCandidates(baseAsset).map(baseOfLabel)) {
    const found = await fetch(base);
    if (listed(found)) return found;
  }
  return direct;
}
export const fetchPerpsLiquidations = (baseAsset: string, client: Pick<typeof apiClient, "getCloudPerpsLiquidations"> = apiClient) =>
  byBaseAsset(baseAsset, async (base) => validatePerpsLiquidations(await client.getCloudPerpsLiquidations(base)));
export const fetchPerpsDepth = (baseAsset: string, client: Pick<typeof apiClient, "getCloudPerpsDepth"> = apiClient) =>
  byBaseAsset(baseAsset, async (base) => validatePerpsDepth(await client.getCloudPerpsDepth(base)));
export const perpsLiquidationsCache = createPluginCache<PerpLiquidationsPayload>({ kind: "perps-liquidations", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
export const perpsDepthCache = createPluginCache<PerpDepthPayload>({ kind: "perps-depth", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 300_000, expireMs: 86_400_000 } });
const cascadeKey = (kind: string, baseAsset: string, access: string) => `${kind}:v1:${baseAsset.toUpperCase()}:${access}`;
export const cachedPerpsLiquidations = (baseAsset: string, access: string) => cachedCloudResource(perpsLiquidationsCache, cascadeKey("liquidations", baseAsset, access), validatePerpsLiquidations);
export const loadPerpsLiquidations = (baseAsset: string, access: string, force = false) => loadCloudResource(perpsLiquidationsCache, cascadeKey("liquidations", baseAsset, access),
  () => fetchPerpsLiquidations(baseAsset), { force, validate: validatePerpsLiquidations });
export const cachedPerpsDepth = (baseAsset: string, access: string) => cachedCloudResource(perpsDepthCache, cascadeKey("depth", baseAsset, access), validatePerpsDepth);
export const loadPerpsDepth = (baseAsset: string, access: string, force = false) => loadCloudResource(perpsDepthCache, cascadeKey("depth", baseAsset, access),
  () => fetchPerpsDepth(baseAsset), { force, validate: validatePerpsDepth });
const sameListing = (value: PerpEquityListing | null | undefined, listing: PerpEquityListing) =>
  value?.symbol === listing.symbol && value.exchange === listing.exchange;
/** The server's proof that a stock contract belongs to the listing asked about. */
const provesListing = (row: PerpBoardRow, listing: PerpEquityListing) => {
  const match = row.equityMatch;
  return sameListing(match?.listing, listing) && row.assetClass === "stocks" && !!match?.underlying.exchange
    && match.underlying.symbol === row.underlyingSymbol
    && (match.basis === "issuer" || match.basis === "listing" && sameListing(match.underlying, listing));
};
function validatePerpsEquity(data: PerpBoardPayload, listing: PerpEquityListing): PerpBoardPayload {
  validatePerpsBoard(data);
  if (!sameListing(data.listing, listing) || !data.rows.every((row) => provesListing(row, listing))) throw new Error("The server returned perpetuals for another listing");
  return data;
}
export const loadPerpsEquity = (listing: PerpEquityListing, access: string, force = false) => {
  const validate = (data: PerpBoardPayload) => validatePerpsEquity(data, listing);
  return loadCloudResource(perpsCache, `equity:v2:${listing.symbol}:${listing.exchange}:${access}`,
    async () => validate(await apiClient.getCloudPerpsEquity(listing.symbol, listing.exchange)), { force, validate });
};

/** The most listings the server looks up in one request; a longer list asks in pages of this size. */
const PERP_EQUITIES_PAGE = 100;
export const perpsListCache = createPluginCache<PerpEquitiesPayload>({ kind: "perps-equities", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
/** One answer per listing asked about, in its order; a contract only with its proof for that listing. */
export function validatePerpsEquities(data: PerpEquitiesPayload, listings: readonly PerpEquityListing[]): PerpEquitiesPayload {
  if (!envelope(data) || !Array.isArray(data.results) || data.results.length !== listings.length
    || !data.results.every((result, index) => !!result && (result.market === null
      || sameListing(result.listing, listings[index]!) && validRow(result.market) && provesListing(result.market, listings[index]!))))
    throw new Error("The server returned perpetuals for another listing");
  return data;
}
async function fetchPerpsEquities(listings: readonly PerpEquityListing[], client: Pick<typeof apiClient, "getCloudPerpsEquities"> = apiClient): Promise<PerpEquitiesPayload> {
  const pages: PerpEquityListing[][] = [];
  for (let start = 0; start < listings.length; start += PERP_EQUITIES_PAGE) pages.push(listings.slice(start, start + PERP_EQUITIES_PAGE));
  const answers = await Promise.all(pages.map(async (page) => validatePerpsEquities(await client.getCloudPerpsEquities(page), page)));
  const [first] = answers;
  if (!first) return { status: "ok", asOf: null, access: "preview", locked: 0, results: [] };
  return { ...first, locked: answers.reduce((sum, answer) => sum + answer.locked, 0), results: answers.flatMap((answer) => answer.results) };
}
/**
 * The perpetual of every listing in a watchlist or portfolio, from one request (one per hundred listings): the
 * rows share one lookup instead of asking for each stock. `listings` come sorted and unique, so a list keeps its
 * cache entry whatever its order; cached per account and plan like the other perps loaders, and a failed refresh
 * keeps the last answer, marked stale.
 */
export const loadPerpsEquities = (listings: readonly PerpEquityListing[], access: string, force = false) => {
  const validate = (data: PerpEquitiesPayload) => validatePerpsEquities(data, listings);
  return loadCloudResource(perpsListCache, `equities:v1:${listings.map((listing) => `${listing.symbol}:${listing.exchange}`).join(",")}:${access}`,
    () => fetchPerpsEquities(listings), { force, validate });
};

function validatePerpsMarket<T extends PerpMarketPayload>(data: T): T {
  validatePerpsBoard(data);
  if (!Array.isArray(data.evidence) || !data.evidence.every((row) => date(row.period_at) && date(row.received_at) && typeof row.fingerprint === "string" && (row.superseded_at === null || date(row.superseded_at)))) throw new Error("The server returned unreadable market evidence");
  return data;
}
const fetchPerpsMarket = async (marketId: string, client: Pick<typeof apiClient, "getCloudPerpsMarket"> = apiClient) => validatePerpsMarket(await client.getCloudPerpsMarket(marketId));

/**
 * The Market column's label for a market on a Hyperliquid builder dex (`SP500 · XYZ`) read back as the `xyz:SP500`
 * identity the board search and the venue know it by; anything else is returned as typed.
 */
export const marketQuery = (input: string) => {
  const label = /^([^\s·]+)\s*·\s*([^\s·]+)$/.exec(input.trim());
  return label ? `${label[2]!.toLowerCase()}:${label[1]}` : input.trim();
};
/** What the board's search takes: a pair written with a separator (BTC-USD) searches its base asset, which no board symbol spells. */
export const boardSearchText = (input: string) => { const pair = separatedPairBase(input); return pair ?? marketQuery(input); };
// An identity or symbol, never free text: a market id the server rejects as malformed would surface as raw JSON.
const SAFE_MARKET_ID = /^[\w.:-]+$/;
// A venue's usual contract for a base asset, by the identity a market lookup fetches without the board (the free
// board preview lists a few markets per asset class, an individual market is shown whole). Only the venues
// Gloom Cloud collects are listed; another venue has no contract to open.
const VENUE_CONTRACTS: Record<string, (base: string) => string[]> = {
  hyperliquid: (base) => [`hyperliquid:default:${base}`, `hyperliquid:xyz:${base}`],
  binance: (base) => [`binance:${base}USDT`],
  bybit: (base) => [`bybit:${base}USDT`],
  okx: (base) => [`okx:${base}-USDT-SWAP`, `okx:${base}-USD-SWAP`],
};
/** What a market lookup holds beside the market: how a pair or plain name was read, or the board names near one nothing matched. */
type PerpSelection = PerpMarketPayload & {
  /** The input named no market as typed and was read as another name; `others` are the contracts that also fit it. */
  resolved?: { input: string; others: string[] };
  /** Board names near an input that matched nothing, as the Market column writes them. */
  suggestions?: string[];
};

type PerpMarketClient = Pick<typeof apiClient, "getCloudPerpsBoard" | "getCloudPerpsMarket">;
const SUGGESTED_MARKETS = 4;
/** Words of an input that say which currency a pair is quoted in, not which market it is. */
const QUOTE_WORDS = new Set(["USD", "USDT", "USDC", "PERP", "SWAP"]);

/**
 * The board names nearest an input nothing matched: markets whose symbol, base asset or name carry a word of it
 * (or all but its last letters), the biggest first, written as the Market column writes them (`BZ`, `BRENTOIL · XYZ`). Free text with several
 * words is no market name and gets none. A board that cannot be read leaves the caller its own examples.
 */
export async function nearestPerpMarkets(input: string, client: Pick<typeof apiClient, "getCloudPerpsBoard"> = apiClient): Promise<string[]> {
  const typed = marketQuery(input);
  if (typed.split(/\s+/).length > 2) return [];
  const words = [...new Set(typed.replace(/^[a-z]+:/i, "").toUpperCase().split(/[^A-Z0-9]+/).filter((word) => word.length >= 3 && !QUOTE_WORDS.has(word)))].slice(0, 2);
  // The server searches for the text inside a name, so a slip at the end of a word (brentt) is found by dropping letters from it.
  const found = await Promise.all(words.map(async (word) => {
    for (let length = word.length; length >= Math.min(word.length, Math.max(4, word.length - 2)); length -= 1) {
      const text = word.slice(0, length);
      try {
        const rows = (await client.getCloudPerpsBoard({ search: text })).rows.filter((row) => !row.delisted
          && `${row.symbol} ${row.baseAsset} ${row.displayName}`.toUpperCase().includes(text));
        if (rows.length) return rows;
      } catch { /* Intentional ignore: a board that cannot be read suggests nothing, so the caller keeps its own examples. */ return []; }
    }
    return [];
  }));
  const rows = found.flat().sort((a, b) => (b.openInterestUsd ?? -Infinity) - (a.openInterestUsd ?? -Infinity));
  return [...new Set(rows.map(marketLabel))].slice(0, SUGGESTED_MARKETS);
}

/**
 * One market by base asset, underlying, symbol, canonical identity or the Market column's label (`SP500 · XYZ`), or by
 * a name the board does not spell: a pair (BTC-USD, BTC/USD, BTCUSD) or a plain name (bitcoin, brent), read as the
 * base asset it stands for once the input names no market as typed. An input that names none comes back with no
 * rows and the board names nearest to it.
 * A `venue` opens that venue's contract, from the board's matches or by its own identity; when the venue has none
 * the usual market comes back and the caller sees its venue differ.
 */
export async function fetchPerpSelection(input: string, client: PerpMarketClient = apiClient, venue?: string): Promise<PerpSelection> {
  const typed = await selectPerpMarket(input, client, venue);
  if (typed.rows.length) return typed;
  const candidates = perpBaseCandidates(marketQuery(input));
  for (const [index, name] of candidates.entries()) {
    const found = await selectPerpMarket(name, client, venue);
    if (found.rows.length) return { ...found, resolved: { input, others: candidates.filter((_, other) => other !== index) } };
  }
  const suggestions = await nearestPerpMarkets(input, client);
  return suggestions.length ? { ...typed, suggestions } : typed;
}

async function selectPerpMarket(input: string, client: PerpMarketClient, venue?: string): Promise<PerpMarketPayload> {
  const query = marketQuery(input) || "BTC";
  if (/^(hyperliquid|binance|bybit|okx|deribit|coinbase|kraken|dydx):/.test(query)) {
    const result = await fetchPerpsMarket(query, client);
    // A watchlist row is saved upper case; Hyperliquid writes its thousand-unit coins with a small k (kPEPE).
    const kCoin = /^hyperliquid:default:K([A-Z0-9]+)$/.exec(query);
    return result.rows.length || !kCoin ? result : fetchPerpsMarket(`hyperliquid:default:k${kCoin[1]}`, client);
  }
  const board = validatePerpsBoard(await client.getCloudPerpsBoard({ search: query }));
  const matches = board.rows.filter((row) => !row.delisted && [row.baseAsset, row.symbol, row.underlyingSymbol].some((value) => value?.toUpperCase() === query.toUpperCase()));
  const exact = venue && matches.some((row) => row.venue === venue) ? matches.filter((row) => row.venue === venue) : matches;
  const market = exact.find((row) => row.dex === "default") ?? exact.find((row) => row.dex === "xyz") ?? exact[0];
  if (venue && market?.venue !== venue && /^[A-Za-z0-9]+$/.test(query)) {
    for (const id of VENUE_CONTRACTS[venue]?.(matches[0]?.baseAsset ?? query.toUpperCase()) ?? []) {
      const result = await fetchPerpsMarket(id, client);
      if (result.rows.length) return result;
    }
  }
  if (market) return fetchPerpsMarket(market.marketId, client);
  // Individual latest-value previews are intentionally broader than the fixed board preview. A builder dex's own
  // identity (`xyz:SP500`) names its Hyperliquid market; a bare symbol is tried on the default dex, then xyz.
  const builder = /^([a-z0-9]+):(.+)$/i.exec(query);
  for (const id of builder ? [`hyperliquid:${builder[1]!.toLowerCase()}:${builder[2]}`] : ["default", "xyz"].map((dex) => `hyperliquid:${dex}:${query.toUpperCase()}`)) {
    if (!SAFE_MARKET_ID.test(id)) continue;
    const result = await fetchPerpsMarket(id, client);
    if (result.rows.length) return result;
  }
  return { ...board, rows: [], evidence: [], methodologyUrl: "https://gloom.sh/docs/perpetuals" };
}
export const perpsMarketCache = createPluginCache<PerpSelection>({ kind: "perps-market", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
export const cachedPerpSelection = (market: string, access: string) => cachedCloudResource(perpsMarketCache, `${market}:${access}`, validatePerpsMarket);
export const loadPerpSelection = (market: string, access: string, force = false) => loadCloudResource(perpsMarketCache, `${market}:${access}`, () => fetchPerpSelection(market), { force, validate: validatePerpsMarket });
export const loadPerpsHistoryForRange = (marketId: string, days: number, access: string, force = false) => loadCloudResource(perpsHistoryCache, `${marketId}:${days}:${access}`, () => fetchPerpsHistory({ marketId,
  from: new Date(Date.now() - days * 86_400_000).toISOString(), resolution: "auto", limit: 5000 }), { force, validate: (data) => validatePerpsHistory(data, marketId) });
