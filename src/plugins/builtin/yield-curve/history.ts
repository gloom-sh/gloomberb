import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import { isYieldObservationDate, TREASURY_MATURITIES, type YieldPoint } from "./treasury-data";

const DAY_MS = 86_400_000;
export type TreasurySeriesLoader = (seriesId: string, options: {
  startDate: string;
  endDate: string;
  limit: number;
  sortOrder: "desc";
}) => Promise<CloudFredSeriesPayload>;

export function yieldCurveDate(value: unknown, now = new Date()): string {
  if (value == null) return "";
  const date = typeof value === "string" ? value.trim() : "";
  if (typeof value === "string" && (date === "" || date.toLowerCase() === "latest")) return "";
  if (!isYieldObservationDate(date)) {
    throw new Error("Use an as-of date in YYYY-MM-DD format, or latest.");
  }
  if (date > now.toISOString().slice(0, 10)) throw new Error("A Treasury curve cannot use a future date.");
  return date;
}

export function completeYieldCurve(points: readonly YieldPoint[]): YieldPoint[] {
  return TREASURY_MATURITIES.map(({ maturity, years }) => {
    const found = points.find((point) => point.maturity === maturity);
    return found && found.yield != null && Number.isFinite(found.yield)
      ? { ...found, maturityYears: years,
        ...(found.asOf != null && !isYieldObservationDate(found.asOf)
          ? { asOf: null, error: `Invalid Treasury observation date: ${found.asOf}` } : {}) }
      : { ...found, maturity, maturityYears: years, yield: null, asOf: null };
  });
}

interface TreasurySeriesResult {
  payload: CloudFredSeriesPayload;
  observations: Array<{ date: string; value: number }>;
  error?: string;
}

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(date) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Every tenor's daily closes between two dates, one request per tenor. */
async function loadTreasurySeries(
  startDate: string,
  endDate: string,
  limit: number,
  loader: TreasurySeriesLoader,
): Promise<PromiseSettledResult<TreasurySeriesResult>[]> {
  return Promise.allSettled(TREASURY_MATURITIES.map(async ({ seriesId }) => {
    const payload = await loader(seriesId, { startDate, endDate, limit, sortOrder: "desc" });
    if (payload.info && payload.info.id !== seriesId) {
      throw new Error(`Expected ${seriesId}, received ${payload.info.id || "unknown series"}`);
    }
    // These fixed DGS series are daily percentages. A metadata endpoint outage
    // can retain usable observations; contradictory metadata must not be used.
    if (payload.info && (payload.info.units?.toLowerCase() !== "percent" || payload.info.frequency?.toLowerCase() !== "daily")) {
      throw new Error(`${seriesId}: unexpected Treasury units or frequency`);
    }
    const invalidDate = payload.observations.find((point) =>
      point.value != null && Number.isFinite(point.value) && !isYieldObservationDate(point.date));
    const observations = payload.observations.filter((point): point is { date: string; value: number } =>
      isYieldObservationDate(point.date) && point.date >= startDate && point.date <= endDate
      && point.value != null && Number.isFinite(point.value));
    return { payload, observations,
      error: invalidDate ? `Invalid Treasury observation date: ${invalidDate.date}` : undefined };
  }));
}

/** The last session every tenor could have published within ten days on or before `endDate`. */
function curveOnOrBefore(results: readonly PromiseSettledResult<TreasurySeriesResult>[], endDate: string): YieldPoint[] {
  const startDate = daysBefore(endDate, 10);
  const inWindow = (point: { date: string }) => point.date >= startDate && point.date <= endDate;
  const dates = results.flatMap((result) => result.status === "fulfilled"
    ? result.value.observations.filter(inWindow).map((point) => point.date) : []);
  const asOf = dates.sort().at(-1);
  const errors = results.flatMap((result, index) => {
    const error = result.status === "rejected"
      ? result.reason instanceof Error ? result.reason.message : String(result.reason)
      : result.value.error;
    return error ? [`${TREASURY_MATURITIES[index]!.maturity}: ${error}`] : [];
  });
  if (!asOf) throw new Error(errors.length
    ? `Treasury curve unavailable: ${errors.join("; ")}`
    : `No Treasury observations available on or within 10 days before ${endDate}.`);
  return TREASURY_MATURITIES.map(({ maturity, years }, index) => {
    const result = results[index]!;
    const data = result.status === "fulfilled" ? result.value : null;
    const point = data?.observations.find((entry) => entry.date === asOf);
    return {
      maturity,
      maturityYears: years,
      yield: point?.value ?? null,
      asOf: point ? asOf : null,
      stale: data?.payload.stale ?? false,
      fetchedAt: data?.payload.fetchedAt,
      error: result.status === "rejected"
        ? result.reason instanceof Error ? result.reason.message : String(result.reason)
        : data?.error,
    };
  });
}

/** Pick one published session on/before the requested date. A lagging tenor is
 * unavailable for that curve, never silently carried from a different session. */
export async function loadHistoricalYieldCurve(
  requestedDate: string,
  loader: TreasurySeriesLoader = (id, options) => apiClient.getCloudFredSeries(id, options),
): Promise<YieldPoint[]> {
  const endDate = yieldCurveDate(requestedDate);
  if (!endDate) throw new Error("A historical curve requires a date.");
  return curveOnOrBefore(await loadTreasurySeries(daysBefore(endDate, 10), endDate, 10, loader), endDate);
}

export type YieldCurveLookbackId = "1W" | "1M";

export interface YieldCurveLookback {
  id: YieldCurveLookbackId;
  /** The day the look-back asks for; the curve is the last session on or before it. */
  requestedDate: string;
  points: YieldPoint[] | null;
  error: string | null;
}

/** A week back is seven calendar days; a month back is the same day of the previous month, or its last day. */
export function yieldCurveLookbackDate(asOf: string, id: YieldCurveLookbackId): string {
  if (id === "1W") return daysBefore(asOf, 7);
  const date = new Date(`${asOf}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

/**
 * The curve a week and a month before `asOf`, by the same session rule as a
 * historical curve. Both come from one request per tenor that spans the two
 * windows, so the look-backs cost what one historical curve does.
 */
export async function loadYieldCurveLookbacks(
  asOf: string,
  loader: TreasurySeriesLoader = (id, options) => apiClient.getCloudFredSeries(id, options),
): Promise<YieldCurveLookback[]> {
  const targets = (["1W", "1M"] as const).map((id) => ({ id, requestedDate: yieldCurveLookbackDate(asOf, id) }));
  const endDate = targets[0]!.requestedDate;
  // About 25 sessions from ten days before the month back to the week back.
  const results = await loadTreasurySeries(daysBefore(targets[1]!.requestedDate, 10), endDate, 40, loader);
  return targets.map((target) => {
    try {
      return { ...target, points: curveOnOrBefore(results, target.requestedDate), error: null };
    } catch (error) {
      return { ...target, points: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
