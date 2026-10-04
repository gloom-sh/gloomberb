import { apiClient } from "../../../api-client";
import type { PerpBoardPayload, PerpBoardRow, PerpHistoryPayload, PerpHistoryQuery, PerpMarketPayload } from "../../../api-client/perps";
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
const fetchPerpsEquity = async (symbol: string, client: Pick<typeof apiClient, "getCloudPerpsEquity"> = apiClient) => validatePerpsBoard(await client.getCloudPerpsEquity(symbol));
export const loadPerpsEquity = (symbol: string, access: string, force = false) => loadCloudResource(perpsCache, `equity:${symbol}:${access}`, () => fetchPerpsEquity(symbol), { force, validate: validatePerpsBoard });

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
