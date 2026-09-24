import { CLOUD_SESSION_REQUIRED } from "../shared/research-cloud-session";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { EstimateRevisionsPayload } from "../../../api-client/estimate-revisions";
import { createPluginCache } from "../../../data/plugin-cache";
import { canonicalExchange, normalizeSymbol } from "../../../utils/exchanges";

export const estimateRevisionsCache =
  createPluginCache<EstimateRevisionsPayload>({
    kind: "estimate-revisions",
    source: "gloom-cloud",
    schemaVersion: 1,
    policy: { staleMs: 5 * 60_000, expireMs: 7 * 86_400_000 },
  });
const number = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const day = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(Date.parse(value)));
const currency = (value: unknown) =>
  value === null || (typeof value === "string" && /^[A-Z]{3}$/.test(value));
export function validateEstimates(
  data: EstimateRevisionsPayload,
  symbol: string,
  exchange: string,
): EstimateRevisionsPayload {
  const invalid = () => {
    throw new Error("Gloom Cloud returned invalid estimate revisions");
  };
  if (
    !data ||
    data.symbol !== normalizeSymbol(symbol) ||
    canonicalExchange(data.exchange) !== canonicalExchange(exchange) ||
    !data.generatedAt ||
    !timestamp(data.generatedAt) ||
    !["available", "partial", "unavailable"].includes(data.status) ||
    !Array.isArray(data.periods) ||
    data.periods.length > 200 ||
    !Array.isArray(data.surprises) ||
    !Array.isArray(data.gaps) ||
    data.gaps.some((x) => typeof x !== "string") ||
    !data.sources ||
    !data.historyCoverage
  )
    return invalid();
  for (const key of ["consensus", "history", "reported", "guidance"] as const) {
    const source = data.sources[key];
    if (
      !source ||
      !["available", "partial", "unavailable"].includes(source.status) ||
      !timestamp(source.fetchedAt) ||
      typeof source.stale !== "boolean" ||
      (source.reason !== null && typeof source.reason !== "string")
    )
      return invalid();
  }
  if (
    !day(data.historyCoverage.since) ||
    !day(data.historyCoverage.until) ||
    typeof data.historyCoverage.truncated !== "boolean" ||
    ![
      data.historyCoverage.excludedRows,
      data.historyCoverage.recordedDays,
      data.historyCoverage.lookbackRows,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    return invalid();
  const identities = new Set<string>();
  for (const period of data.periods) {
    if (
      !period ||
      !["annual", "quarterly"].includes(period.frequency) ||
      !day(period.periodEnd) ||
      !currency(period.currency) ||
      period.id !==
        `${period.frequency}:${period.periodEnd}:${period.currency ?? "unknown"}` ||
      identities.has(period.id) ||
      !Array.isArray(period.recorded) ||
      !Array.isArray(period.lookbacks) ||
      period.recorded.length + period.lookbacks.length > 4000 ||
      !Array.isArray(period.breadth) ||
      !period.percentile ||
      !period.change ||
      !period.dispersionPercentile
    )
      return invalid();
    identities.add(period.id);
    for (const [source, rows] of [
      ["yahoo", period.recorded],
      ["yahoo-eps-trend", period.lookbacks],
    ] as const) {
      const dates = new Set<string>();
      for (const point of rows) {
        if (
          !point ||
          !day(point.date) ||
          point.date > data.generatedAt.slice(0, 10) ||
          !timestamp(point.recordedAt) ||
          point.source !== source ||
          dates.has(point.date) ||
          ![
            point.average,
            point.low,
            point.high,
            point.range,
            point.relativeRange,
            point.analysts,
          ].every(number) ||
          (point.range != null && point.range < 0) ||
          (point.analysts != null &&
            (!Number.isInteger(point.analysts) || point.analysts < 0))
        )
          return invalid();
        dates.add(point.date);
      }
    }
    if (
      period.current &&
      (!day(period.current.date) ||
        period.current.date > data.generatedAt.slice(0, 10) ||
        ![
          period.current.average,
          period.current.low,
          period.current.high,
          period.current.range,
          period.current.relativeRange,
          period.current.analysts,
        ].every(number))
    )
      return invalid();
    if (
      period.revenue &&
      (!currency(period.revenue.currency) ||
        ![
          period.revenue.average,
          period.revenue.low,
          period.revenue.high,
          period.revenue.analysts,
        ].every(number) ||
        (period.revenue.asOf !== null && !day(period.revenue.asOf)))
    )
      return invalid();
    if (
      ![
        period.change.value,
        period.change.percent,
        period.percentile.percentile,
        period.percentile.min,
        period.percentile.max,
        period.percentile.mean,
      ].every(number) ||
      !Number.isSafeInteger(period.percentile.samples) ||
      period.percentile.samples < 0 ||
      period.percentile.samples > period.recorded.length
    )
      return invalid();
    if (
      period.percentile.percentile != null &&
      (period.percentile.samples < 20 ||
        period.percentile.percentile < 0 ||
        period.percentile.percentile > 100)
    )
      return invalid();
    for (const row of period.breadth)
      if (
        ![7, 30].includes(row.days) ||
        ![row.up, row.down, row.net, row.ratio].every(number) ||
        (row.up != null && (!Number.isInteger(row.up) || row.up < 0)) ||
        (row.down != null && (!Number.isInteger(row.down) || row.down < 0))
      )
        return invalid();
  }
  for (const row of data.surprises)
    if (
      !day(row.date) ||
      !["announcement", "fiscal-period-end", "unspecified"].includes(
        row.dateType,
      ) ||
      !Number.isSafeInteger(row.samples) ||
      row.samples < 0 ||
      !currency(row.currency) ||
      ![
        row.estimate,
        row.actual,
        row.difference,
        row.percent,
        row.percentile,
      ].every(number)
    )
      return invalid();
  if (
    data.guidance &&
    (typeof data.guidance.text !== "string" ||
      !data.guidance.text.trim() ||
      typeof data.guidance.transcriptURL !== "string" ||
      !/^https:\/\/gloom\.sh\//.test(data.guidance.transcriptURL) ||
      typeof data.guidance.publishedAt !== "string" ||
      !timestamp(data.guidance.publishedAt) ||
      !timestamp(data.guidance.callDate) ||
      !Number.isSafeInteger(data.guidance.fiscalYear) ||
      !Number.isInteger(data.guidance.fiscalQuarter) ||
      data.guidance.fiscalQuarter < 1 ||
      data.guidance.fiscalQuarter > 4 ||
      data.guidance.source !== "public-transcript-summary" ||
      data.guidance.numericComparison !== null)
  )
    return invalid();
  return data;
}
export async function fetchEstimates(
  symbol: string,
  exchange: string,
  client: Pick<typeof apiClient, "getCloudEstimateRevisions"> &
    Partial<Pick<typeof apiClient, "searchInstruments">> = apiClient,
) {
  let venue = canonicalExchange(exchange);
  if (!venue) {
    const matches = (await client.searchInstruments?.(symbol, 25)) ?? [];
    const venues = new Set(
      matches
        .filter(
          (row) => normalizeSymbol(row.symbol) === normalizeSymbol(symbol),
        )
        .map((row) => canonicalExchange(row.primaryExchange || row.exchange))
        .filter(Boolean),
    );
    if (venues.size !== 1)
      throw new Error(
        "Choose a listing exchange for estimate revisions, for example AAPL:NASDAQ.",
      );
    venue = [...venues][0]!;
  }
  try {
    return validateEstimates(
      await client.getCloudEstimateRevisions(symbol, venue),
      symbol,
      venue,
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404)
      throw new Error(
        "Estimate revisions is not available on this Gloom Cloud server yet",
      );
    // The route answers a missing or unverified session with a bare 401/403; the pane's sign-in wall keys on the shared gate.
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403))
      throw new Error(CLOUD_SESSION_REQUIRED);
    throw error;
  }
}
const key = (symbol: string, exchange: string) =>
  `${canonicalExchange(exchange)}:${normalizeSymbol(symbol)}`;
// Seeds the first paint while the mount load runs; cache age is not staleness,
// and a failed refresh reports its own.
export function cachedEstimates(symbol: string, exchange: string) {
  const result = estimateRevisionsCache.get(key(symbol, exchange), {
    allowExpired: true,
  });
  if (!result) return null;
  try {
    return {
      payload: validateEstimates(
        result.data,
        symbol,
        exchange || result.data.exchange,
      ),
      stale: false,
      refreshError: null as string | null,
    };
  } catch {
    return null;
  }
}
export async function loadEstimates(
  symbol: string,
  exchange: string,
  force = false,
) {
  const result = await estimateRevisionsCache.load(
    key(symbol, exchange),
    () => fetchEstimates(symbol, exchange),
    { force },
  );
  if (
    result.error instanceof ApiRequestError &&
    [401, 403].includes(result.error.status ?? 0)
  )
    throw result.error;
  return {
    payload: validateEstimates(
      result.data,
      symbol,
      exchange || result.data.exchange,
    ),
    stale: result.stale,
    refreshError: result.refreshError ?? null,
  };
}
