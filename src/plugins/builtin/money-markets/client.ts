import { apiClient } from "../../../api-client";
import type { HongKongMoneyMarketsPayload, MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

export const moneyMarketsCache = createPluginCache<MoneyMarketsPayload>({
  kind: "money-markets", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});
export const hongKongMoneyMarketsCache = createPluginCache<HongKongMoneyMarketsPayload>({
  kind: "money-markets-hk", source: "gloom-cloud", schemaVersion: 1,
  policy: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
});

const finiteOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const dateOrNull = (value: unknown) => value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

const invalid = (): never => { throw new Error("The server returned invalid money-market observations"); };

/** Rows of the board's groups with dated, finite values and a year's rank, or the payload is refused. */
function validateRows(rows: readonly MoneyMarketRow[], groups: readonly MoneyMarketRow["group"][]): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return invalid();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.label !== "string" || !groups.includes(row.group)
      || !["percent", "usd-billions"].includes(row.unit) || !["daily", "weekly"].includes(row.frequency)
      || !["available", "stale", "unavailable"].includes(row.status)
      || row.changeUnit !== (row.unit === "percent" ? "basis-points" : "usd-billions")
      || !finiteOrNull(row.value) || !finiteOrNull(row.change) || !finiteOrNull(row.previousValue)
      || !dateOrNull(row.asOf) || !dateOrNull(row.previousAsOf) || row.value != null && row.asOf == null
      || !Array.isArray(row.history) || row.history.some((point) => point.date == null || !dateOrNull(point.date) || !finiteOrNull(point.value))
      || !Array.isArray(row.sourceSeriesIds) || row.sourceSeriesIds.some((id) => typeof id !== "string") || !Array.isArray(row.notes)) return invalid();
  }
  for (const stats of rows.map((row) => row.percentile)) validatePercentile(stats);
}

function validatePercentile(stats: MoneyMarketRow["percentile"] | undefined): void {
  if (!stats || !finiteOrNull(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
    || !Number.isInteger(stats.sampleCount) || stats.sampleCount < 0
    || !finiteOrNull(stats.min) || !finiteOrNull(stats.max) || !finiteOrNull(stats.mean)
    || !dateOrNull(stats.windowStart) || !dateOrNull(stats.windowEnd)) invalid();
}

/** Reject incompatible contracts rather than supplying zeros to a board or curve. */
export function validateMoneyMarkets(payload: MoneyMarketsPayload): MoneyMarketsPayload {
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || !payload.netLiquidity || !payload.billsCurve || !Array.isArray(payload.billsCurve.comparisons)
    || payload.billsCurve.basis !== "discount" || !["available", "stale", "unavailable"].includes(payload.billsCurve.status)) return invalid();
  validateRows([...payload.rows, payload.netLiquidity], ["rates", "bills", "liquidity"]);
  validatePercentile(payload.billsCurve.slope?.percentile);
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

/** Hong Kong's HIBOR board, refused whole when a row is not a dated HIBOR fixing. */
export function validateHongKongMoneyMarkets(payload: HongKongMoneyMarketsPayload): HongKongMoneyMarketsPayload {
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || typeof payload.source?.name !== "string") return invalid();
  validateRows(payload.rows, ["hibor"]);
  return payload;
}

export async function fetchHongKongMoneyMarkets(client: Pick<typeof apiClient, "getCloudHongKongMoneyMarkets"> = apiClient): Promise<HongKongMoneyMarketsPayload> {
  try { return validateHongKongMoneyMarkets(await client.getCloudHongKongMoneyMarkets()); }
  catch (error) { throw unavailableOnServer(error, "Hong Kong money markets are not available yet."); }
}

export const getCachedHongKongMoneyMarkets = () => cachedCloudResource(hongKongMoneyMarketsCache, "hkd");
export const loadHongKongMoneyMarkets = (force = false) => loadCloudResource(hongKongMoneyMarketsCache, "hkd", () => fetchHongKongMoneyMarkets(), { force });
