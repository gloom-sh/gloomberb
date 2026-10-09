import { apiClient } from "../../../api-client";
import type { PerpBoardPayload, PerpBoardQuery, PerpBoardRow, PerpEquityListing, PerpHistoryPayload, PerpHistoryQuery, PerpMarketPayload, PerpRankingsPayload } from "../../../api-client/perps";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource } from "../shared/cloud-resource";

export const perpsCache = createPluginCache<PerpBoardPayload>({ kind: "perps-board", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
export const perpsHistoryCache = createPluginCache<PerpHistoryPayload>({ kind: "perps-history", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60_000, expireMs: 86_400_000 } });
const finiteOrNull = (n: unknown) => n === null || typeof n === "number" && Number.isFinite(n);
const date = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));
function validRow(row: PerpBoardRow) {
  return !!row && typeof row.marketId === "string" && typeof row.symbol === "string" && typeof row.displayName === "string"
    && typeof row.baseAsset === "string" && typeof row.quoteCurrency === "string" && typeof row.marginCurrency === "string"
    && date(row.observedAt) && typeof row.sourceUrl === "string" && Array.isArray(row.qualityFlags)
    && [row.markPrice, row.oraclePrice, row.fundingRate, row.fundingIntervalHours, row.fundingRate8h, row.fundingApr,
      row.predictedFundingRate, row.predictedFundingIntervalHours, row.openInterestBase, row.openInterestUsd, row.volume24hUsd,
      row.premium, row.oiChange24h, row.closedMarketPremium].every(finiteOrNull)
    && (row.fundingIntervalHours === null || row.fundingIntervalHours > 0);
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
    || !data.candles.every((row) => date(row.time) && [row.open, row.high, row.low, row.close].every((n) => typeof n === "number" && Number.isFinite(n)) && row.marketId === data.marketId && date(row.observedAt) && typeof row.sourceUrl === "string")) throw new Error("The server returned unreadable perpetual history");
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
export const fetchPerpsBoard = async (query: PerpBoardQuery, client: Pick<typeof apiClient, "getCloudPerpsBoard"> = apiClient) => validatePerpsBoard(await client.getCloudPerpsBoard(query));
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
function validatePerpsEquity(data: PerpBoardPayload, listing: PerpEquityListing): PerpBoardPayload {
  validatePerpsBoard(data);
  const same = (value: PerpEquityListing | null | undefined) => value?.symbol === listing.symbol && value.exchange === listing.exchange;
  if (!same(data.listing) || !data.rows.every((row) => {
    const match = row.equityMatch;
    return same(match?.listing) && row.assetClass === "stocks" && !!match?.underlying.exchange
      && match.underlying.symbol === row.underlyingSymbol
      && (match.basis === "issuer" || match.basis === "listing" && same(match.underlying));
  })) throw new Error("The server returned perpetuals for another listing");
  return data;
}
export const loadPerpsEquity = (listing: PerpEquityListing, access: string, force = false) => {
  const validate = (data: PerpBoardPayload) => validatePerpsEquity(data, listing);
  return loadCloudResource(perpsCache, `equity:v2:${listing.symbol}:${listing.exchange}:${access}`,
    async () => validate(await apiClient.getCloudPerpsEquity(listing.symbol, listing.exchange)), { force, validate });
};

function validatePerpsMarket(data: PerpMarketPayload): PerpMarketPayload {
  validatePerpsBoard(data);
  if (!Array.isArray(data.evidence) || !data.evidence.every((row) => date(row.period_at) && date(row.received_at) && typeof row.fingerprint === "string" && (row.superseded_at === null || date(row.superseded_at)))) throw new Error("The server returned unreadable market evidence");
  return data;
}
const fetchPerpsMarket = async (marketId: string, client: Pick<typeof apiClient, "getCloudPerpsMarket"> = apiClient) => validatePerpsMarket(await client.getCloudPerpsMarket(marketId));

export async function fetchPerpSelection(input: string, client: Pick<typeof apiClient, "getCloudPerpsBoard" | "getCloudPerpsMarket"> = apiClient): Promise<PerpMarketPayload> {
  const query = input.trim() || "BTC";
  if (/^(hyperliquid|binance|bybit|okx|deribit|coinbase|kraken|dydx):/.test(query)) return fetchPerpsMarket(query, client);
  const board = validatePerpsBoard(await client.getCloudPerpsBoard({ search: query }));
  const exact = board.rows.filter((row) => !row.delisted && [row.baseAsset, row.symbol, row.underlyingSymbol].some((value) => value?.toUpperCase() === query.toUpperCase()));
  const market = exact.find((row) => row.dex === "default") ?? exact.find((row) => row.dex === "xyz") ?? exact[0];
  if (market) return fetchPerpsMarket(market.marketId, client);
  // Individual latest-value previews are intentionally broader than the fixed board preview.
  for (const dex of ["default", "xyz"]) {
    const result = await fetchPerpsMarket(`hyperliquid:${dex}:${query.toUpperCase()}`, client);
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
