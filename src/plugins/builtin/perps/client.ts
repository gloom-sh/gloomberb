import { apiClient } from "../../../api-client";
import type { PerpBoardPayload, PerpBoardRow, PerpHistoryPayload, PerpHistoryQuery, PerpRankingsPayload } from "../../../api-client/perps";
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
export function validatePerpsHistory(data: PerpHistoryPayload): PerpHistoryPayload {
  if (!envelope(data) || !Array.isArray(data.rows) || !Array.isArray(data.funding) || !Array.isArray(data.candles)
    || !data.rows.every((row) => date(row.time) && [row.markPrice, row.oraclePrice, row.premium, row.fundingRate, row.fundingIntervalHours, row.openInterestBase, row.openInterestUsd].every(finiteOrNull))
    || !data.funding.every((row) => date(row.time) && typeof row.rate === "number" && Number.isFinite(row.rate) && row.intervalHours > 0)
    || !data.candles.every((row) => date(row.time) && [row.open, row.high, row.low, row.close].every((n) => typeof n === "number" && Number.isFinite(n)))) throw new Error("The server returned unreadable perpetual history");
  return data;
}
export const RANKING_KEYS = ["fundingPositive", "fundingNegative", "oiSurges", "premiumDislocations", "closedMarketDislocations"] as const;
function validatePerpsRankings(data: PerpRankingsPayload) {
  if (!envelope(data) || !RANKING_KEYS.every((key) => Array.isArray(data[key]) && data[key].every(validRow))) throw new Error("The server returned unreadable perpetual rankings");
  return data;
}
export const fetchPerpsBoard = async (client: Pick<typeof apiClient, "getCloudPerpsBoard"> = apiClient) => validatePerpsBoard(await client.getCloudPerpsBoard());
export const fetchPerpsHistory = async (query: PerpHistoryQuery, client: Pick<typeof apiClient, "getCloudPerpsHistory"> = apiClient) => validatePerpsHistory(await client.getCloudPerpsHistory(query));
export const fetchPerpsRankings = async (client: Pick<typeof apiClient, "getCloudPerpsRankings"> = apiClient) => validatePerpsRankings(await client.getCloudPerpsRankings());
export const fetchPerpsCompare = async (base: string, client: Pick<typeof apiClient, "getCloudPerpsCompare"> = apiClient) => validatePerpsBoard(await client.getCloudPerpsCompare(base));
const fetchPerpsEquity = async (symbol: string, client: Pick<typeof apiClient, "getCloudPerpsEquity"> = apiClient) => validatePerpsBoard(await client.getCloudPerpsEquity(symbol));
export const cachedPerps = (access: string) => cachedCloudResource(perpsCache, `board:${access}`, validatePerpsBoard);
export const loadPerps = (access: string, force = false) => loadCloudResource(perpsCache, `board:${access}`, () => fetchPerpsBoard(), { force, validate: validatePerpsBoard });
export const loadPerpsEquity = (symbol: string, access: string, force = false) => loadCloudResource(perpsCache, `equity:${symbol}:${access}`, () => fetchPerpsEquity(symbol), { force, validate: validatePerpsBoard });
export const loadPerpsCompare = (base: string, access: string, force = false) => loadCloudResource(perpsCache, `compare:${base}:${access}`, () => fetchPerpsCompare(base), { force, validate: validatePerpsBoard });
export const loadPerpsHistory = (query: PerpHistoryQuery, access: string, force = false) => loadCloudResource(perpsHistoryCache, `${JSON.stringify(query)}:${access}`, () => fetchPerpsHistory(query), { force, validate: validatePerpsHistory });

export async function fetchPerpsMarket(marketId: string, client: Pick<typeof apiClient, "getCloudPerpsMarket"> = apiClient) {
  const data = await client.getCloudPerpsMarket(marketId);
  validatePerpsBoard(data);
  if (!Array.isArray(data.evidence) || !data.evidence.every((row) => date(row.period_at) && date(row.received_at) && typeof row.fingerprint === "string")) throw new Error("The server returned unreadable market evidence");
  return data;
}
