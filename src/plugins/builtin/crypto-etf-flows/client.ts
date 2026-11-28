import { apiClient } from "../../../api-client";
import type { CryptoEtfFlowAsset, CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import { isCalendarDay, isIsoInstant, isNonEmptyText, isNullableFinite, isNullableText } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

/**
 * The flows as served, or an error: the asset asked for, its funds once each,
 * every day newest first with a figure or none for each fund, and where they
 * are from. A payload that breaks any of it is not drawn. A day's price move
 * that is not a number or null is dropped from that day alone: the flows
 * stand without it.
 */
function validateCryptoEtfFlows(payload: CryptoEtfFlowsPayload, asset: CryptoEtfFlowAsset): CryptoEtfFlowsPayload {
  const invalid = (): never => { throw new Error("The server returned invalid crypto ETF flows"); };
  if (!payload || payload.asset !== asset || payload.unit !== "USD millions" || !Array.isArray(payload.funds)
    || !Array.isArray(payload.days) || !isCalendarDay(payload.asOf) || !isIsoInstant(payload.fetchedAt)
    || typeof payload.stale !== "boolean" || !payload.source || !isNonEmptyText(payload.source.publisher) || !isNonEmptyText(payload.source.url)) return invalid();
  const tickers = payload.funds.map((fund) => fund?.ticker);
  if (!tickers.length || tickers.some((ticker) => !isNonEmptyText(ticker)) || new Set(tickers).size !== tickers.length
    || payload.funds.some((fund) => !isNullableText(fund.name) || !isNullableText(fund.issuer))) return invalid();
  const known = new Set(tickers);
  for (const [index, day] of payload.days.entries()) {
    if (!day || !isCalendarDay(day.date) || (index > 0 && day.date >= payload.days[index - 1]!.date) || !isNullableFinite(day.total)
      || !day.flows || typeof day.flows !== "object" || Object.entries(day.flows).some(([ticker, value]) => !known.has(ticker) || !isNullableFinite(value))
      || !Array.isArray(day.pending) || day.pending.some((ticker) => !known.has(ticker))) return invalid();
  }
  if (payload.days[0] && payload.days[0].date !== payload.asOf) return invalid();
  if (payload.days.every((day) => day.priceChangePct === undefined || isNullableFinite(day.priceChangePct))) return payload;
  return { ...payload, days: payload.days.map((day) => {
    if (day.priceChangePct === undefined || isNullableFinite(day.priceChangePct)) return day;
    const { priceChangePct: _dropped, ...rest } = day;
    return rest;
  }) };
}

const cryptoEtfFlowsEndpoint = createCloudEndpoint<CryptoEtfFlowAsset, CryptoEtfFlowsPayload, Pick<typeof apiClient, "getCloudCryptoEtfFlows">>({
  kind: "crypto-etf-flows", schemaVersion: 1,
  // Flows post once a trading day, in the US evening and the next morning in Europe.
  policy: { staleMs: 15 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  key: (asset) => asset, defaultClient: apiClient,
  fetch: (asset, client) => client.getCloudCryptoEtfFlows(asset),
  validate: validateCryptoEtfFlows,
  // 404 from a server without the route; 503 until the first read is stored.
  unavailableMessage: "Crypto ETF flows are not available yet.", unavailableStatuses: [404, 503],
});

export const cryptoEtfFlowsCache = cryptoEtfFlowsEndpoint.cache;
export const fetchCryptoEtfFlows = (asset: CryptoEtfFlowAsset, client: Pick<typeof apiClient, "getCloudCryptoEtfFlows"> = apiClient) =>
  cryptoEtfFlowsEndpoint.fetch(asset, { client });
export const cachedCryptoEtfFlows = (asset: CryptoEtfFlowAsset) => cryptoEtfFlowsEndpoint.cached(asset);
export const loadCryptoEtfFlows = (asset: CryptoEtfFlowAsset, force = false) => cryptoEtfFlowsEndpoint.load(asset, { force });
