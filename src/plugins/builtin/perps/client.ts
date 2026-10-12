import { apiClient } from "../../../api-client";
import type { PerpBoardPayload, PerpBoardQuery, PerpBoardRow, PerpEquitiesPayload, PerpEquityListing, PerpHistoryPayload, PerpHistoryQuery, PerpLongShortPoint,
  PerpLongShortRatio, PerpMarketPayload, PerpRankingsPayload } from "../../../api-client/perps";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";

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
function validatePerpsCompare(data: PerpBoardPayload, baseAsset: string): PerpBoardPayload {
  validatePerpsBoard(data);
  if (!data.rows.every((row) => row.baseAsset.toUpperCase() === baseAsset.toUpperCase())) throw new Error("The server returned contracts for another asset");
  return data;
}
export const fetchPerpsCompare = async (baseAsset: string, client: Pick<typeof apiClient, "getCloudPerpsCompare"> = apiClient) => validatePerpsCompare(await client.getCloudPerpsCompare(baseAsset), baseAsset);
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

function validatePerpsMarket(data: PerpMarketPayload): PerpMarketPayload {
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
/**
 * One market by base asset, underlying, symbol, canonical identity or the Market column's label (`SP500 · XYZ`).
 * A `venue` opens that venue's contract, from the board's matches or by its own identity; when the venue has none
 * the usual market comes back and the caller sees its venue differ.
 */
export async function fetchPerpSelection(input: string, client: Pick<typeof apiClient, "getCloudPerpsBoard" | "getCloudPerpsMarket"> = apiClient, venue?: string): Promise<PerpMarketPayload> {
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
export const perpsMarketCache = createPluginCache<PerpMarketPayload>({ kind: "perps-market", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
export const cachedPerpSelection = (market: string, access: string) => cachedCloudResource(perpsMarketCache, `${market}:${access}`, validatePerpsMarket);
export const loadPerpSelection = (market: string, access: string, force = false) => loadCloudResource(perpsMarketCache, `${market}:${access}`, () => fetchPerpSelection(market), { force, validate: validatePerpsMarket });
export const loadPerpsHistoryForRange = (marketId: string, days: number, access: string, force = false) => loadCloudResource(perpsHistoryCache, `${marketId}:${days}:${access}`, () => fetchPerpsHistory({ marketId,
  from: new Date(Date.now() - days * 86_400_000).toISOString(), resolution: "auto", limit: 5000 }), { force, validate: (data) => validatePerpsHistory(data, marketId) });
