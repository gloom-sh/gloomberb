import { apiClient } from "../../../api-client";
import type { CryptoEtfFlowAsset, CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const cryptoEtfFlowsCache = createPluginCache<CryptoEtfFlowsPayload>({
  kind: "crypto-etf-flows", source: "gloom-cloud", schemaVersion: 1,
  // Flows post once a trading day, in the US evening and the next morning in Europe.
  policy: { staleMs: 15 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const flow = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const textOrNull = (value: unknown) => value === null || text(value);

/**
 * The flows as served, or an error: the asset asked for, its funds once each,
 * every day newest first with a figure or none for each fund, and where they
 * are from. A payload that breaks any of it is not drawn. A day's price move
 * that is not a number or null is dropped from that day alone: the flows
 * stand without it.
 */
export function validateCryptoEtfFlows(payload: CryptoEtfFlowsPayload, asset: CryptoEtfFlowAsset): CryptoEtfFlowsPayload {
  const invalid = (): never => { throw new Error("The server returned invalid crypto ETF flows"); };
  if (!payload || payload.asset !== asset || payload.unit !== "USD millions" || !Array.isArray(payload.funds)
    || !Array.isArray(payload.days) || !date(payload.asOf) || !text(payload.fetchedAt) || !Number.isFinite(Date.parse(payload.fetchedAt))
    || typeof payload.stale !== "boolean" || !payload.source || !text(payload.source.publisher) || !text(payload.source.url)) return invalid();
  const tickers = payload.funds.map((fund) => fund?.ticker);
  if (!tickers.length || tickers.some((ticker) => !text(ticker)) || new Set(tickers).size !== tickers.length
    || payload.funds.some((fund) => !textOrNull(fund.name) || !textOrNull(fund.issuer))) return invalid();
  const known = new Set(tickers);
  for (const [index, day] of payload.days.entries()) {
    if (!day || !date(day.date) || (index > 0 && day.date >= payload.days[index - 1]!.date) || !flow(day.total)
      || !day.flows || typeof day.flows !== "object" || Object.entries(day.flows).some(([ticker, value]) => !known.has(ticker) || !flow(value))
      || !Array.isArray(day.pending) || day.pending.some((ticker) => !known.has(ticker))) return invalid();
  }
  if (payload.days[0] && payload.days[0].date !== payload.asOf) return invalid();
  if (payload.days.every((day) => day.priceChangePct === undefined || flow(day.priceChangePct))) return payload;
  return { ...payload, days: payload.days.map((day) => {
    if (day.priceChangePct === undefined || flow(day.priceChangePct)) return day;
    const { priceChangePct: _dropped, ...rest } = day;
    return rest;
  }) };
}

export async function fetchCryptoEtfFlows(
  asset: CryptoEtfFlowAsset,
  client: Pick<typeof apiClient, "getCloudCryptoEtfFlows"> = apiClient,
): Promise<CryptoEtfFlowsPayload> {
  try {
    return validateCryptoEtfFlows(await client.getCloudCryptoEtfFlows(asset), asset);
  } catch (error) {
    // 404 from a server without the route; 503 until the first read is stored.
    throw unavailableOnServer(error, "Crypto ETF flows are not available yet.", [404, 503]);
  }
}

export function cachedCryptoEtfFlows(asset: CryptoEtfFlowAsset) {
  return cachedCloudResource(cryptoEtfFlowsCache, asset, (payload) => validateCryptoEtfFlows(payload, asset));
}

export function loadCryptoEtfFlows(asset: CryptoEtfFlowAsset, force = false) {
  return loadCloudResource(cryptoEtfFlowsCache, asset, () => fetchCryptoEtfFlows(asset),
    { force, validate: (payload) => validateCryptoEtfFlows(payload, asset) });
}
