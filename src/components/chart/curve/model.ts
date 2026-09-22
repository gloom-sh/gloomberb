import type { ResolvedSeries } from "../../../time-series/types";
import { staticSeries } from "../static/series";

export interface CurvePoint {
  id: string;
  label: string;
  x: number;
  value: number | null;
  asOf?: string | null;
}

export interface CurveSeries {
  id: string;
  label: string;
  asOf?: string | null;
  color?: string;
  style?: "line" | "points";
  points: readonly CurvePoint[];
}

export interface HistoryObservation {
  date: string | Date;
  value: number | null;
}

export interface HistoryStatistics {
  percentile: number | null;
  /** Count below the current value plus half the tied observations. */
  rank: number | null;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  startDate: string | null;
  endDate: string | null;
}

function observationTime(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return NaN;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return NaN;
  return Date.parse(value);
}

/** Midrank percentile, consistent with volatility cones. A flat history is 50.
 * Bounds are inclusive calendar dates. Future observations never enter a rank. */
export function historyStatistics(
  history: readonly HistoryObservation[],
  current: number | null,
  options: { asOf?: string | Date; windowDays?: number; startDate?: string | Date } = {},
): HistoryStatistics {
  const asOf = options.asOf == null ? Date.now() : observationTime(options.asOf);
  const end = asOf + (typeof options.asOf === "string" && options.asOf.length === 10 ? 86_400_000 - 1 : 0);
  const start = options.startDate != null ? observationTime(options.startDate)
    : options.windowDays != null ? asOf - options.windowDays * 86_400_000 : -Infinity;
  const dated = new Map<number, number | null>();
  for (const point of history) {
    const date = observationTime(point.date);
    if (Number.isFinite(date) && date >= start && date <= end) {
      dated.set(date, point.value);
    }
  }
  // Apply the last published correction before removing gaps. A null correction
  // must erase an older value for that observation instead of resurrecting it.
  const points = [...dated].filter((point): point is [number, number] => point[1] != null && Number.isFinite(point[1]))
    .sort((a, b) => a[0] - b[0]);
  const values = points.map(([, value]) => value);
  const count = values.length;
  const rank = current != null && Number.isFinite(current) && count
    ? values.reduce((sum, value) => sum + (value < current ? 1 : value === current ? 0.5 : 0), 0) : null;
  return {
    percentile: rank == null ? null : 100 * rank / count,
    rank,
    count,
    min: count ? Math.min(...values) : null,
    max: count ? Math.max(...values) : null,
    mean: count ? values.reduce((sum, value) => sum + value / count, 0) : null,
    startDate: points.length ? new Date(points[0]![0]).toISOString().slice(0, 10) : null,
    endDate: points.length ? new Date(points.at(-1)![0]).toISOString().slice(0, 10) : null,
  };
}

/** Endpoint differences use the declared nodes, never the next available tenor. */
export function curveSlope(series: CurveSeries, options: { frontId?: string; backId?: string; multiplier?: number } = {}): number | null {
  const points = series.points.filter((point) => Number.isFinite(point.x)).toSorted((a, b) => a.x - b.x);
  const front = options.frontId ? points.find((point) => point.id === options.frontId) : points[0];
  const back = options.backId ? points.find((point) => point.id === options.backId) : points.at(-1);
  if (!front || !back || front === back || front.value == null || back.value == null
    || !Number.isFinite(front.value) || !Number.isFinite(back.value)) return null;
  const frontDate = front.asOf ?? series.asOf;
  const backDate = back.asOf ?? series.asOf;
  if (!frontDate || !backDate || !Number.isFinite(observationTime(frontDate))
    || observationTime(frontDate) !== observationTime(backDate)) return null;
  return (back.value - front.value) * (options.multiplier ?? 1);
}

export interface CurveTableRow {
  id: string;
  label: string;
  x: number;
  points: Record<string, CurvePoint>;
}

export function curveTableRows(series: readonly CurveSeries[]): CurveTableRow[] {
  const rows = new Map<string, CurveTableRow>();
  for (const entry of series) for (const point of entry.points) {
    if (!Number.isFinite(point.x)) continue;
    const row = rows.get(point.id) ?? { id: point.id, label: point.label, x: point.x, points: {} };
    row.points[entry.id] = point;
    rows.set(point.id, row);
  }
  return [...rows.values()].sort((a, b) => a.x - b.x);
}

// A normalized numeric domain gives the existing calendar projection an exact
// continuous axis for either tenors or epoch timestamps. Dates are never labels.
const COORDINATE_SPAN = 1_000_000_000_000;

export function buildCurveChart(series: readonly CurveSeries[], width: number, colors: readonly string[]) {
  const coordinates = series.flatMap((entry) => entry.points.map((point) => point.x).filter(Number.isFinite));
  const min = coordinates.length ? Math.min(...coordinates) : 0;
  const max = coordinates.length ? Math.max(...coordinates) : min;
  const span = max - min;
  const toDate = (x: number) => new Date(Math.round(span > 0 ? (x - min) / span * COORDINATE_SPAN : 0));
  const fromDate = (date: Date) => min + date.getTime() / COORDINATE_SPAN * span;
  const resolved: ResolvedSeries[] = series.map((entry, index) => staticSeries(
    entry.points.filter((point) => Number.isFinite(point.x)).toSorted((a, b) => a.x - b.x).map((point) => ({
      date: toDate(point.x),
      observedAt: toDate(point.x),
      value: point.value != null && Number.isFinite(point.value) ? point.value : null,
    })),
    { id: entry.id, label: entry.label, color: entry.color ?? colors[index % Math.max(1, colors.length)] ?? "#ffffff",
      style: entry.style, calendarSpaced: true },
  ));
  const candidates = [...new Map(series.flatMap((entry) => entry.points)
    .filter((point) => Number.isFinite(point.x)).map((point) => [point.x, point])).values()].sort((a, b) => a.x - b.x);
  const ticks: Array<{ label: string; ratio: number }> = [];
  const addTick = (point: CurvePoint | undefined) => {
    if (!point) return;
    const ratio = span ? (point.x - min) / span : 0;
    if (ticks.some((tick) => Math.abs(tick.ratio - ratio) * Math.max(1, width - 1) < Math.max(6, point.label.length + 1))) return;
    ticks.push({ label: point.label, ratio });
  };
  addTick(candidates[0]);
  addTick(candidates.at(-1));
  // Long tenors remain legible while the short-end geometry stays continuous.
  for (const point of candidates.toReversed()) addTick(point);
  return { series: resolved, min, max, toDate, fromDate, ticks: ticks.sort((a, b) => a.ratio - b.ratio) };
}
