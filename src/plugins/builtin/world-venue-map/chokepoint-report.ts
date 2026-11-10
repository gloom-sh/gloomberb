/**
 * `gloom fn CHOKE`: the chart's report, each strait's latest day beside its
 * 7- and 28-day averages and the change against the same 28 days a year
 * before, which the chart's year of points does not reach.
 */
import type { GeoRequest } from "../../../api-client/geo";
import type { HeadlessPaneContext, HeadlessSeries, HeadlessSeriesResult, HeadlessSeriesTrailing } from "../../../types/headless";
import { GEO_SERIES_CAPABILITY_ID } from "../chart-composer/series-expression";
import { resolveGeoChartSeries } from "./geo-series";

const DAY_MS = 86_400_000;

interface DatedValue {
  time: number;
  value: number;
}

function datedValues(points: readonly { date: string | number | Date; value?: number | null }[]): DatedValue[] {
  return points.flatMap((point) => {
    const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
    return Number.isFinite(time) && typeof point.value === "number" && Number.isFinite(point.value) ? [{ time, value: point.value }] : [];
  });
}

/** The day one calendar year before `time`; 29 Feb falls back to 28 Feb. */
function yearBefore(time: number): number {
  const date = new Date(time);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/**
 * The days a window needs values on for its mean to stand for it: 6 of 7, 24
 * of 28. A chart read over a week (`--range 1w`) printed a "28-day" average
 * of 7 days, and a series that starts mid-window one of its few last days.
 */
const COVERED_DAYS: Readonly<Record<number, number>> = { 7: 6, 28: 24 };

/**
 * The mean of the values dated in the `days` days that end on `end`, or null
 * when fewer of those days have one than `COVERED_DAYS` asks.
 */
function windowMean(values: readonly DatedValue[], end: number, days: number): number | null {
  const inside = values.filter((entry) => entry.time <= end && entry.time > end - days * DAY_MS);
  const covered = new Set(inside.map((entry) => Math.floor(entry.time / DAY_MS))).size;
  if (!inside.length || covered < (COVERED_DAYS[days] ?? days)) return null;
  return inside.reduce((sum, entry) => sum + entry.value, 0) / inside.length;
}

/** Whether the values reach back to the first day of the `days` days that end on `end`. */
function reaches(values: readonly DatedValue[], end: number, days: number): boolean {
  return values.some((entry) => entry.time <= end - (days - 1) * DAY_MS);
}

/**
 * A daily series' averages to its latest day. The year-ago window is read
 * from `yearAgo` when given (points the chart's range does not reach), else
 * from the series' own points. A window short of its days (`COVERED_DAYS`),
 * now or a year before, is null, and so is the change it would give.
 */
export function trailingAverages(
  points: readonly { date: string | number | Date; value?: number | null }[],
  yearAgo?: readonly { date: string | number | Date; value?: number | null }[],
): HeadlessSeriesTrailing | null {
  const values = datedValues(points);
  const latest = values.reduce((newest, entry) => Math.max(newest, entry.time), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(latest)) return null;
  const avg7 = windowMean(values, latest, 7);
  const avg28 = windowMean(values, latest, 28);
  const yearAgoEnd = yearBefore(latest);
  const earlier = yearAgo ? datedValues(yearAgo) : values;
  const yearAgoAvg28 = windowMean(earlier, yearAgoEnd, 28);
  const changeVsYearAgoPct = avg28 != null && yearAgoAvg28 != null && yearAgoAvg28 !== 0
    ? (avg28 / yearAgoAvg28 - 1) * 100
    : null;
  return { avg7, avg28, yearAgoAvg28, changeVsYearAgoPct };
}

/** The map series a chart series is of (`CAP:geo-series:HORMUZ` is HORMUZ), or null for any other source. */
function geoSeriesToken(series: Pick<HeadlessSeries, "symbol">): string | null {
  const prefix = `CAP:${GEO_SERIES_CAPABILITY_ID}:`;
  return series.symbol?.startsWith(prefix) ? series.symbol.slice(prefix.length) || null : null;
}

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** The 28 days a year before the series' latest day, read on their own: the chart's year starts after them. */
async function yearAgoPoints(request: GeoRequest, token: string, series: HeadlessSeries, signal?: AbortSignal) {
  const values = datedValues(series.points);
  if (!values.length) return undefined;
  const latest = Math.max(...values.map((entry) => entry.time));
  const end = yearBefore(latest);
  // Already in the chart's points, or no change to make: the 28 days to the latest are short (`--range 1w`).
  if (reaches(values, end, 28) || windowMean(values, latest, 28) == null) return undefined;
  const window = { start: isoDay(end - 27 * DAY_MS), end: isoDay(end) };
  const resolved = await resolveGeoChartSeries(request, token, { range: "1Y", resolution: "auto", dateWindow: window }, signal);
  return resolved.points.map((point) => ({ date: point.date, value: point.value }));
}

/** CHOKE's series, each with its trailing averages; a year-ago window that cannot be read leaves that change out. */
export async function withTransitAverages(
  result: HeadlessSeriesResult,
  request: GeoRequest,
  context: Pick<HeadlessPaneContext, "signal">,
): Promise<HeadlessSeriesResult> {
  const series = await Promise.all(result.series.map(async (entry) => {
    const token = geoSeriesToken(entry);
    if (!token || !entry.points.length) return entry;
    const yearAgo = await yearAgoPoints(request, token, entry, context.signal).catch((error: unknown) => {
      if (context.signal?.aborted) throw error;
      return [];
    });
    const trailing = trailingAverages(entry.points, yearAgo);
    return trailing ? { ...entry, trailing } : entry;
  }));
  return { ...result, series };
}
