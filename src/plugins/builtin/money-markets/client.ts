import { apiClient } from "../../../api-client";
import type { MoneyMarketsPayload } from "../../../api-client/money-markets";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const moneyMarketsCache = createPluginCache<MoneyMarketsPayload>({
  kind: "money-markets", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const dateOrNull = (value: unknown) => value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Reject incompatible contracts rather than supplying zeros to a board or curve. */
export function validateMoneyMarkets(payload: MoneyMarketsPayload): MoneyMarketsPayload {
  const invalid = () => { throw new Error("The server returned invalid money-market observations"); };
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || !payload.netLiquidity || !payload.billsCurve || !Array.isArray(payload.billsCurve.comparisons)
    || payload.billsCurve.basis !== "discount" || !["available", "stale", "unavailable"].includes(payload.billsCurve.status)) return invalid();
  const rows = [...payload.rows, payload.netLiquidity];
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return invalid();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.label !== "string" || !["rates", "bills", "liquidity"].includes(row.group)
      || !["percent", "usd-billions"].includes(row.unit) || !["daily", "weekly"].includes(row.frequency)
      || !["available", "stale", "unavailable"].includes(row.status)
      || row.changeUnit !== (row.unit === "percent" ? "basis-points" : "usd-billions")
      || !finiteOrNull(row.value) || !finiteOrNull(row.change) || !finiteOrNull(row.previousValue)
      || !dateOrNull(row.asOf) || !dateOrNull(row.previousAsOf) || row.value != null && row.asOf == null
      || !Array.isArray(row.history) || row.history.some((point) => point.date == null || !dateOrNull(point.date) || !finiteOrNull(point.value))
      || !Array.isArray(row.sourceSeriesIds) || row.sourceSeriesIds.some((id) => typeof id !== "string") || !Array.isArray(row.notes)) return invalid();
  }
  for (const stats of [...rows.map((row) => row.percentile), payload.billsCurve.slope?.percentile]) {
    if (!stats || !finiteOrNull(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
      || !Number.isInteger(stats.sampleCount) || stats.sampleCount < 0
      || !finiteOrNull(stats.min) || !finiteOrNull(stats.max) || !finiteOrNull(stats.mean)
      || !dateOrNull(stats.windowStart) || !dateOrNull(stats.windowEnd)) return invalid();
  }
  for (const snapshot of [payload.billsCurve, ...payload.billsCurve.comparisons]) {
    if (!dateOrNull(snapshot.asOf) || !Array.isArray(snapshot.points) || snapshot.points.some((point) =>
      !Number.isFinite(point.value) || !Number.isFinite(point.maturityYears) || point.maturityYears <= 0
      || typeof point.tenor !== "string") || snapshot.points.length > 0 && snapshot.asOf == null) return invalid();
  }
  if (!finiteOrNull(payload.billsCurve.slope.valueBps) || !dateOrNull(payload.billsCurve.slope.asOf)) return invalid();
  return payload;
}

export async function fetchMoneyMarkets(client: Pick<typeof apiClient, "getCloudMoneyMarkets"> = apiClient): Promise<MoneyMarketsPayload> {
  try { return validateMoneyMarkets(await client.getCloudMoneyMarkets()); }
  catch (error) { throw unavailableOnServer(error, "Money markets are not available yet."); }
}

export const getCachedMoneyMarkets = () => cachedCloudResource(moneyMarketsCache, "usd");
export const loadMoneyMarkets = (force = false) => loadCloudResource(moneyMarketsCache, "usd", () => fetchMoneyMarkets(), { force });
