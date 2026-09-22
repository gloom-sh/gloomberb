import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CryptoBoardPayload, CryptoPercentile } from "../../../api-client/crypto-board";
import { createPluginCache } from "../../../data/plugin-cache";
export const cryptoBoardCache = createPluginCache<CryptoBoardPayload>({
  kind: "crypto-board",
  source: "gloom-cloud",
  schemaVersion: 1,
  policy: { staleMs: 30_000, expireMs: 7 * 86_400_000 },
});
const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);
const numberOrNull = (n: unknown) => n === null || finite(n);
const instant = (s: unknown): s is string => typeof s === "string" && Number.isFinite(Date.parse(s));
const date = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  instant(s) &&
  new Date(s).toISOString().slice(0, 10) === s;
const nullableDate = (s: unknown) => s === null || date(s);
const nullableInstant = (s: unknown) => s === null || instant(s);
const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
function validPercentile(p: CryptoPercentile): boolean {
  return (
    !!p &&
    numberOrNull(p.value) &&
    (p.value == null || (p.value >= 0 && p.value <= 100)) &&
    count(p.sampleCount) &&
    (p.value == null || p.sampleCount >= 20) &&
    numberOrNull(p.rank) &&
    [p.min, p.max, p.mean].every(numberOrNull) &&
    date(p.windowStart) &&
    date(p.windowEnd) &&
    p.windowStart <= p.windowEnd &&
    nullableDate(p.historyStart) &&
    nullableDate(p.historyEnd) &&
    typeof p.completeWindow === "boolean"
  );
}
export function validateCryptoBoard(data: CryptoBoardPayload): CryptoBoardPayload {
  const invalid = () => {
    throw new Error("Gloom Cloud returned invalid crypto observations");
  };
  if (
    !data ||
    data.version !== 1 ||
    !instant(data.generatedAt) ||
    !nullableInstant(data.asOf) ||
    !["available", "partial", "unavailable"].includes(data.status) ||
    !Array.isArray(data.rows) ||
    data.rows.length > 32 ||
    !data.source ||
    data.source.venue !== "us" ||
    typeof data.source.url !== "string" ||
    typeof data.source.methodologyUrl !== "string" ||
    typeof data.source.priceBasis !== "string" ||
    typeof data.source.volumeBasis !== "string" ||
    !nullableInstant(data.source.snapshotsFetchedAt) ||
    !nullableInstant(data.source.historyFetchedAt) ||
    !Array.isArray(data.warnings) ||
    data.warnings.some((warning) => typeof warning !== "string") ||
    !data.freshness ||
    ![data.freshness.currentPrices, data.freshness.stalePrices, data.freshness.unavailablePrices].every(
      count,
    ) ||
    new Set(data.rows.map((row) => row.symbol)).size !== data.rows.length
  )
    return invalid();
  for (const row of data.rows) {
    if (
      !row ||
      !/^[A-Z]+-USD$/.test(row.symbol) ||
      row.providerSymbol !== row.symbol.replace("-", "/") ||
      row.symbol !== `${row.baseCurrency}-USD` ||
      row.quoteCurrency !== "USD" ||
      typeof row.name !== "string" ||
      !["available", "partial", "unavailable"].includes(row.status) ||
      !nullableInstant(row.asOf) ||
      !row.price ||
      !numberOrNull(row.price.value) ||
      (row.price.value != null && row.price.value <= 0) ||
      !nullableInstant(row.price.asOf) ||
      (row.price.value != null && row.price.asOf == null) ||
      row.asOf !== row.price.asOf ||
      row.price.basis !== "latest-trade" ||
      !["current", "stale", "unavailable"].includes(row.price.freshness) ||
      (row.price.freshness === "unavailable" && row.price.value !== null) ||
      !row.dailyChange ||
      row.dailyChange.basis !== "since-prior-utc-close" ||
      !numberOrNull(row.dailyChange.valuePercent) ||
      !numberOrNull(row.dailyChange.referenceClose) ||
      !nullableDate(row.dailyChange.referenceDate) ||
      !nullableInstant(row.dailyChange.asOf) ||
      (row.dailyChange.valuePercent != null &&
        (row.dailyChange.referenceClose == null ||
          row.dailyChange.referenceClose <= 0 ||
          row.dailyChange.referenceDate == null ||
          row.dailyChange.asOf == null)) ||
      !row.return7d ||
      row.return7d.basis !== "completed-utc-closes" ||
      !numberOrNull(row.return7d.valuePercent) ||
      !date(row.return7d.startDate) ||
      !date(row.return7d.endDate) ||
      !nullableInstant(row.return7d.asOf) ||
      Date.parse(row.return7d.endDate) - Date.parse(row.return7d.startDate) !== 7 * 86_400_000 ||
      !row.volume ||
      row.volume.unit !== row.baseCurrency ||
      row.volume.basis !== "completed-utc-day" ||
      !numberOrNull(row.volume.value) ||
      (row.volume.value != null && row.volume.value < 0) ||
      !nullableInstant(row.volume.asOf) ||
      !instant(row.volume.periodStart) ||
      !instant(row.volume.periodEnd) ||
      Date.parse(row.volume.periodEnd) - Date.parse(row.volume.periodStart) !== 86_400_000 ||
      ![
        row.price.percentile,
        row.dailyChange.percentile,
        row.return7d.percentile,
        row.volume.percentile,
      ].every(validPercentile) ||
      row.price.percentile.referenceBasis !== "completed-utc-bars-with-quote-midpoints" ||
      !Array.isArray(row.history) ||
      row.history.length > 367 ||
      !Array.isArray(row.warnings) ||
      row.warnings.some((warning) => typeof warning !== "string")
    )
      return invalid();
    for (let i = 0; i < row.history.length; i++) {
      const point = row.history[i]!;
      if (
        !date(point.date) ||
        (i > 0 && Date.parse(point.date) - Date.parse(row.history[i - 1]!.date) !== 86_400_000) ||
        !numberOrNull(point.close) ||
        !numberOrNull(point.volume) ||
        (point.volume != null && point.volume < 0) ||
        (point.tradeCount !== null && !count(point.tradeCount)) ||
        !["observed", "quote-only", "missing"].includes(point.status)
      )
        return invalid();
      if (
        point.status === "missing"
          ? [point.close, point.volume, point.tradeCount].some((value) => value !== null)
          : point.close == null ||
            point.close <= 0 ||
            point.volume == null ||
            point.tradeCount == null ||
            (point.status === "quote-only" && (point.tradeCount !== 0 || point.volume !== 0)) ||
            (point.status === "observed" && (point.tradeCount === 0 || point.volume === 0))
      )
        return invalid();
    }
    const coverage = row.coverage;
    if (
      !coverage ||
      !date(coverage.windowStart) ||
      !date(coverage.windowEnd) ||
      ![coverage.expectedDays, coverage.observedDays, coverage.missingDays, coverage.quoteOnlyDays].every(
        count,
      ) ||
      coverage.expectedDays !== row.history.length ||
      coverage.observedDays + coverage.missingDays !== coverage.expectedDays ||
      coverage.quoteOnlyDays > coverage.observedDays ||
      typeof coverage.completeWindow !== "boolean"
    )
      return invalid();
  }
  return data;
}
export async function fetchCryptoBoard(
  client: Pick<typeof apiClient, "getCloudCryptoBoard"> = apiClient,
): Promise<CryptoBoardPayload> {
  try {
    return validateCryptoBoard(await client.getCloudCryptoBoard());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404)
      throw new Error("Crypto board is not available on this Gloom Cloud server yet");
    if (error instanceof ApiRequestError && error.status === 503)
      throw new Error("Crypto board sources are temporarily unavailable");
    throw error;
  }
}
export interface CryptoBoardResource {
  payload: CryptoBoardPayload;
  stale: boolean;
  refreshError: string | null;
}
export function cachedCryptoBoard(): CryptoBoardResource | null {
  const cached = cryptoBoardCache.get("usd", { allowExpired: true });
  if (!cached) return null;
  try {
    return { payload: validateCryptoBoard(cached.data), stale: cached.stale, refreshError: null };
  } catch {
    return null;
  }
}
export async function loadCryptoBoard(force = false): Promise<CryptoBoardResource> {
  const result = await cryptoBoardCache.load("usd", () => fetchCryptoBoard(), { force });
  if (result.error instanceof ApiRequestError && [401, 403].includes(result.error.status ?? 0))
    throw result.error;
  return {
    payload: validateCryptoBoard(result.data),
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
