import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import { TREASURY_MATURITIES, type YieldPoint } from "./treasury-data";

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
  const timestamp = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error("Use an as-of date in YYYY-MM-DD format, or latest.");
  }
  if (date > now.toISOString().slice(0, 10)) throw new Error("A Treasury curve cannot use a future date.");
  return date;
}

export function completeYieldCurve(points: readonly YieldPoint[]): YieldPoint[] {
  return TREASURY_MATURITIES.map(({ maturity, years }) => {
    const found = points.find((point) => point.maturity === maturity);
    return found && found.yield != null && Number.isFinite(found.yield)
      ? { ...found, maturityYears: years }
      : { ...found, maturity, maturityYears: years, yield: null, asOf: null };
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
  const startDate = new Date(Date.parse(endDate) - 10 * DAY_MS).toISOString().slice(0, 10);
  const results = await Promise.allSettled(TREASURY_MATURITIES.map(async ({ seriesId }) => {
    const payload = await loader(seriesId, { startDate, endDate, limit: 10, sortOrder: "desc" });
    // These fixed DGS series are daily percentages. A metadata endpoint outage
    // can retain usable observations; contradictory metadata must not be used.
    if (payload.info && (payload.info.units?.toLowerCase() !== "percent" || payload.info.frequency?.toLowerCase() !== "daily")) {
      throw new Error(`${seriesId}: unexpected Treasury units or frequency`);
    }
    const observations = payload.observations.filter((point): point is { date: string; value: number } =>
      /^\d{4}-\d{2}-\d{2}$/.test(point.date) && point.date >= startDate && point.date <= endDate
      && point.value != null && Number.isFinite(point.value));
    return { payload, observations };
  }));
  const dates = results.flatMap((result) => result.status === "fulfilled"
    ? result.value.observations.map((point) => point.date) : []);
  const asOf = dates.sort().at(-1);
  if (!asOf) throw new Error(`No Treasury observations available on or within 10 days before ${endDate}.`);
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
    };
  });
}
