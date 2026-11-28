import { apiClient } from "../../../api-client";
import type { HongKongMoneyMarketsPayload, MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import { hasUniqueIds, isNonNegativeInt, isNullableCalendarDay, isNullableFinite, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

const policy = { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 };
const invalid = (): never => { throw new Error("The server returned invalid money-market observations"); };

/** Rows of the board's groups with dated, finite values and a year's rank, or the payload is refused. */
function validateRows(rows: readonly MoneyMarketRow[], groups: readonly MoneyMarketRow["group"][]): void {
  if (!hasUniqueIds(rows)) return invalid();
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.label !== "string" || !groups.includes(row.group)
      || !["percent", "usd-billions"].includes(row.unit) || !["daily", "weekly"].includes(row.frequency)
      || !["available", "stale", "unavailable"].includes(row.status)
      || row.changeUnit !== (row.unit === "percent" ? "basis-points" : "usd-billions")
      || !isNullableFinite(row.value) || !isNullableFinite(row.change) || !isNullableFinite(row.previousValue)
      || !isNullableCalendarDay(row.asOf) || !isNullableCalendarDay(row.previousAsOf) || row.value != null && row.asOf == null
      || !Array.isArray(row.history) || row.history.some((point) => point.date == null || !isNullableCalendarDay(point.date) || !isNullableFinite(point.value))
      || !isStringArray(row.sourceSeriesIds) || !Array.isArray(row.notes)
      || row.couponEquivalent !== undefined && !isNullableFinite(row.couponEquivalent)
      || row.couponEquivalentAsOf !== undefined && !isNullableCalendarDay(row.couponEquivalentAsOf)
      || row.sourceName !== undefined && typeof row.sourceName !== "string") return invalid();
  }
  for (const stats of rows.map((row) => row.percentile)) validatePercentile(stats);
}

function validatePercentile(stats: MoneyMarketRow["percentile"] | undefined): void {
  if (!stats || !isNullableFinite(stats.value) || stats.value != null && (stats.value < 0 || stats.value > 100)
    || !isNonNegativeInt(stats.sampleCount)
    || !isNullableFinite(stats.min) || !isNullableFinite(stats.max) || !isNullableFinite(stats.mean)
    || !isNullableCalendarDay(stats.windowStart) || !isNullableCalendarDay(stats.windowEnd)) invalid();
}

/** Reject incompatible contracts rather than supplying zeros to a board or curve. */
function validateMoneyMarkets(payload: MoneyMarketsPayload): MoneyMarketsPayload {
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || !payload.netLiquidity || !payload.billsCurve || !Array.isArray(payload.billsCurve.comparisons)
    || payload.billsCurve.basis !== "discount" || !["available", "stale", "unavailable"].includes(payload.billsCurve.status)) return invalid();
  validateRows([...payload.rows, payload.netLiquidity], ["rates", "bills", "liquidity"]);
  validatePercentile(payload.billsCurve.slope?.percentile);
  for (const snapshot of [payload.billsCurve, ...payload.billsCurve.comparisons]) {
    if (!isNullableCalendarDay(snapshot.asOf) || !Array.isArray(snapshot.points) || snapshot.points.some((point) =>
      !Number.isFinite(point.value) || !Number.isFinite(point.maturityYears) || point.maturityYears <= 0
      || typeof point.tenor !== "string") || snapshot.points.length > 0 && snapshot.asOf == null) return invalid();
  }
  if (!isNullableFinite(payload.billsCurve.slope.valueBps) || !isNullableCalendarDay(payload.billsCurve.slope.asOf)) return invalid();
  return payload;
}

/** Hong Kong's bill-yield board, refused whole when a row is not a dated Exchange Fund Bill yield. */
function validateHongKongMoneyMarkets(payload: HongKongMoneyMarketsPayload): HongKongMoneyMarketsPayload {
  if (!payload || !Number.isFinite(Date.parse(payload.generatedAt)) || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.rows) || typeof payload.source?.name !== "string") return invalid();
  validateRows(payload.rows, ["efb"]);
  return payload;
}

const moneyMarketsEndpoint = createCloudEndpoint<void, MoneyMarketsPayload, Pick<typeof apiClient, "getCloudMoneyMarkets">>({
  kind: "money-markets", schemaVersion: 1, policy, key: "usd", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudMoneyMarkets(), validate: validateMoneyMarkets,
  unavailableMessage: "Money markets are not available yet.",
});
const hongKongMoneyMarketsEndpoint = createCloudEndpoint<void, HongKongMoneyMarketsPayload, Pick<typeof apiClient, "getCloudHongKongMoneyMarkets">>({
  kind: "money-markets-hk", schemaVersion: 1, policy, key: "hkd", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudHongKongMoneyMarkets(), validate: validateHongKongMoneyMarkets,
  unavailableMessage: "Hong Kong money markets are not available yet.",
});

export const moneyMarketsCache = moneyMarketsEndpoint.cache;
export const hongKongMoneyMarketsCache = hongKongMoneyMarketsEndpoint.cache;
export const getCachedMoneyMarkets = () => moneyMarketsEndpoint.cached();
export const loadMoneyMarkets = (force = false, client: Pick<typeof apiClient, "getCloudMoneyMarkets"> = apiClient) =>
  moneyMarketsEndpoint.load(undefined, { force, client });
export const getCachedHongKongMoneyMarkets = () => hongKongMoneyMarketsEndpoint.cached();
export const loadHongKongMoneyMarkets = (force = false, client: Pick<typeof apiClient, "getCloudHongKongMoneyMarkets"> = apiClient) =>
  hongKongMoneyMarketsEndpoint.load(undefined, { force, client });
