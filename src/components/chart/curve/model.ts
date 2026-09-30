import type { ResolvedSeries } from "../../../time-series/types";
import { displayWidth } from "../../../utils/format";
import type { ChartStripSpec } from "../../chart-table/header";
import { compositeAxisTicks, type CompositeAxisValueFormatter } from "../composite/format";
import { buildCompositeChartScene } from "../composite/scene";
import { staticSeries } from "../static/series";

export interface CurvePoint {
  id: string;
  label: string;
  x: number;
  value: number | null;
  asOf?: string | null;
}

/**
 * What a series is to the curve. The primary is the curve the rows, the
 * cursor and the readout follow; a ghost is a look-back read as a change
 * against it; a reference (a policy rate, a flat line) is drawn and named once
 * but is never a row; a marker is points at their own x, never a row or a step.
 */
export type CurveSeriesRole = "primary" | "ghost" | "reference" | "marker";

/** How x spreads across the plot: by value, by log value (maturities), or one slot per row. */
export type CurveXScale = "linear" | "log" | "even";

export interface CurveSeries {
  id: string;
  label: string;
  asOf?: string | null;
  color?: string;
  /** Keep dated table/cursor context without changing chart axes. */
  chartVisible?: boolean;
  /** "step" holds each value until the next point, for a rate set at discrete dates. */
  style?: "line" | "points" | "step";
  /** Defaults to primary for the primary series and ghost for the rest. */
  role?: CurveSeriesRole;
  points: readonly CurvePoint[];
}

/** Series whose points are curve rows: everything but references and markers. */
export function isCurveRowSeries(entry: CurveSeries): boolean {
  return entry.role !== "reference" && entry.role !== "marker";
}

/** The curve the rows follow: the named one, else the first primary, else the first row series. */
export function curvePrimarySeries(series: readonly CurveSeries[], primarySeriesId?: string): CurveSeries | undefined {
  return series.find((entry) => entry.id === primarySeriesId)
    ?? series.find((entry) => entry.role === "primary")
    ?? series.find(isCurveRowSeries)
    ?? series[0];
}

/** Look-backs read as how long ago they were: "1W" becomes "1W ago". */
export function curveLookbackLabel(label: string): string {
  return /^\d+[DWMY]$/i.test(label.trim()) ? `${label.trim()} ago` : label;
}

export interface CurvePalette {
  current: string;
  ghosts: Readonly<Record<string, string>>;
}

/** One colour per look-back in every curve pane, so a 1M ghost reads the same in CTM and WIRP. */
export function curveGhostColors(colors: { textMuted: string; textDim: string; warning: string }): Readonly<Record<string, string>> {
  return { "1W": colors.textMuted, "1M": colors.warning, "1Y": colors.textDim };
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
  return {
    ...sampleStatistics(values, current),
    startDate: points.length ? new Date(points[0]![0]).toISOString().slice(0, 10) : null,
    endDate: points.length ? new Date(points.at(-1)![0]).toISOString().slice(0, 10) : null,
  };
}

/** Midrank statistics for observations whose identities are not calendar timestamps. */
export function sampleStatistics(sample: readonly number[], current: number | null): Omit<HistoryStatistics, "startDate" | "endDate"> {
  const values = sample.filter(Number.isFinite);
  const count = values.length;
  const rank = current != null && Number.isFinite(current) && count
    ? values.reduce((sum, value) => sum + (value < current ? 1 : value === current ? 0.5 : 0), 0) : null;
  return {
    percentile: rank == null ? null : 100 * rank / count,
    rank, count,
    min: count ? Math.min(...values) : null,
    max: count ? Math.max(...values) : null,
    mean: count ? values.reduce((sum, value) => sum + value / count, 0) : null,
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
  for (const entry of series.filter(isCurveRowSeries)) for (const point of entry.points) {
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

interface CurveScale {
  min: number;
  max: number;
  /** Where x sits across the plot, 0 at the left edge and 1 at the right. */
  ratio: (x: number) => number;
  value: (ratio: number) => number;
}

function linearScale(min: number, max: number): CurveScale {
  const span = max - min;
  return { min, max, ratio: (x) => span > 0 ? (x - min) / span : 0, value: (ratio) => min + ratio * span };
}

function curveScale(coordinates: readonly number[], rowCoordinates: readonly number[], kind: CurveXScale): CurveScale {
  const min = coordinates.length ? Math.min(...coordinates) : 0;
  const max = coordinates.length ? Math.max(...coordinates) : min;
  // A log axis needs positive maturities; anything else reads by value.
  if (kind === "log" && min > 0 && max > min) {
    const low = Math.log(min);
    const span = Math.log(max) - low;
    return { min, max, ratio: (x) => x > 0 ? (Math.log(x) - low) / span : 0, value: (ratio) => Math.exp(low + ratio * span) };
  }
  const knots = [...new Set(rowCoordinates.length ? rowCoordinates : coordinates)].sort((a, b) => a - b);
  if (kind !== "even" || knots.length < 2) return linearScale(min, max);
  // One slot per row; anything between two rows (a marker, a ghost's own
  // maturity) sits between their slots in proportion.
  const last = knots.length - 1;
  return {
    min, max,
    ratio: (x) => {
      if (x <= knots[0]!) return 0;
      if (x >= knots[last]!) return 1;
      const index = knots.findIndex((knot) => knot > x) - 1;
      return (index + (x - knots[index]!) / (knots[index + 1]! - knots[index]!)) / last;
    },
    value: (ratio) => {
      const position = Math.max(0, Math.min(last, ratio * last));
      const index = Math.min(last - 1, Math.floor(position));
      return knots[index]! + (position - index) * (knots[index + 1]! - knots[index]!);
    },
  };
}

export interface CurveChartOptions {
  xScale?: CurveXScale;
}

export function buildCurveChart(series: readonly CurveSeries[], width: number, colors: readonly string[], options: CurveChartOptions = {}) {
  const plotted = series.filter((entry) => entry.chartVisible !== false);
  const rowSeries = plotted.filter(isCurveRowSeries);
  const finiteX = (entries: readonly CurveSeries[]) => entries.flatMap((entry) => entry.points.map((point) => point.x).filter(Number.isFinite));
  const scale = curveScale(finiteX(plotted), finiteX(rowSeries), options.xScale ?? "linear");
  const { min, max } = scale;
  const toDate = (x: number) => new Date(Math.round(scale.ratio(x) * COORDINATE_SPAN));
  const fromDate = (date: Date) => scale.value(date.getTime() / COORDINATE_SPAN);
  const resolved: ResolvedSeries[] = plotted.map((entry, index) => staticSeries(
    entry.points.filter((point) => Number.isFinite(point.x)).toSorted((a, b) => a.x - b.x).map((point) => ({
      date: toDate(point.x),
      observedAt: toDate(point.x),
      value: point.value != null && Number.isFinite(point.value) ? point.value : null,
    })),
    { id: entry.id, label: entry.label, color: entry.color ?? colors[index % Math.max(1, colors.length)] ?? "#ffffff",
      style: entry.role === "marker" ? "points" : entry.style, calendarSpaced: true },
  ));
  // References and markers are not maturities of the curve, so they never label the axis.
  const candidates = [...new Map((rowSeries.length ? rowSeries : plotted).flatMap((entry) => entry.points)
    .filter((point) => Number.isFinite(point.x)).map((point) => [point.x, point])).values()].sort((a, b) => a.x - b.x);
  const ticksAt = (plotWidth: number) => {
    const ticks: Array<{ label: string; ratio: number }> = [];
    const columns = Math.max(1, plotWidth - 1);
    // The axis centers each label on its tick but pins one that would spill past
    // an edge, so the first and last labels extend inward by their full width.
    const extent = (label: string, ratio: number) => {
      const left = Math.max(0, Math.min(plotWidth - label.length, Math.round(ratio * columns) - Math.floor(label.length / 2)));
      return [left, left + label.length] as const;
    };
    const addTick = (point: CurvePoint | undefined) => {
      if (!point) return;
      const ratio = scale.ratio(point.x);
      const [left, right] = extent(point.label, ratio);
      if (ticks.some((tick) => {
        const [tickLeft, tickRight] = extent(tick.label, tick.ratio);
        return Math.abs(tick.ratio - ratio) * columns < 6 || (left <= tickRight && tickLeft <= right);
      })) return;
      ticks.push({ label: point.label, ratio });
    };
    addTick(candidates[0]);
    addTick(candidates.at(-1));
    // Long tenors remain legible while the short-end geometry stays continuous.
    for (const point of candidates.toReversed()) addTick(point);
    return ticks.sort((a, b) => a.ratio - b.ratio);
  };
  // A chart date is the point's place across the plot, so it reads back as a ratio.
  const dateRatio = (date: Date) => date.getTime() / COORDINATE_SPAN;
  return { series: resolved, min, max, toDate, fromDate, ratioOf: scale.ratio, dateRatio, ticksAt, ticks: ticksAt(width) };
}

/** Cells the value axis leaves the plot, estimated the way the chart sizes its gutter. */
export function curvePlotWidth(series: ResolvedSeries[], width: number, plotHeight: number,
  format: CompositeAxisValueFormatter | undefined): number {
  const total = Math.max(1, Math.floor(width));
  const scene = buildCompositeChartScene(series, [{ id: "main" }], { width: 1, height: Math.max(1, plotHeight), rightOffsetRatio: 0 });
  const panel = scene?.panels[0];
  const domain = panel?.axes.right ?? panel?.axes.left;
  if (!domain) return total;
  const labels = compositeAxisTicks(domain, format).flatMap(({ label, value }) => {
    // The gutter also fits the cursor's value, probed at more digits than a round tick.
    const probe = (value < 0 ? -1 : 1) * (Math.floor(Math.abs(value)) + 0.1234);
    return [label, format ? format(probe, domain) : label];
  });
  const labelWidth = Math.max(3, ...labels.map(displayWidth));
  const minimumPlot = Math.min(total, Math.max(12, Math.floor(total / 2)));
  const axis = Math.min(labelWidth, Math.max(0, total - minimumPlot - 1));
  return Math.max(1, total - axis - (axis > 0 ? 1 : 0));
}

/** A series in a legend without a caption: its label and, when dated, its time. */
export function curveLegendText(entry: CurveSeries): string {
  return `${entry.label}${entry.asOf ? ` · ${entry.asOf.replace("T", " ").slice(0, 16)}` : ""}`;
}

/** The drawn series of a legend without a caption, wrapped into rows at this width. */
export function curveLegendLayout(series: readonly CurveSeries[], width: number): CurveSeries[][] {
  const rows: CurveSeries[][] = [];
  let used = 0;
  for (const entry of series) {
    if (entry.chartVisible === false) continue;
    const textWidth = displayWidth(curveLegendText(entry));
    const last = rows.at(-1);
    if (last && used + textWidth <= width - 2) last.push(entry);
    else { rows.push([entry]); used = 0; }
    used += textWidth + 3;
  }
  return rows;
}

/** Legend rows a curve surface spends at this width: one with a caption, else its wrapped series labels. */
function curveLegendRows(series: readonly CurveSeries[], width: number, caption?: string): number {
  return caption ? 1 : curveLegendLayout(series, width).length;
}

/**
 * Rows a curve surface needs to read: its legend, four plot rows, the axis
 * and the readout. The chart-table kit drops the band to a strip below this.
 */
export function curveSurfaceMinRows({ series, width, caption, slope = false }: {
  series: readonly CurveSeries[];
  width: number;
  caption?: string;
  slope?: boolean;
}): number {
  return Math.max(1, curveLegendRows(series, width, caption)) + 6 + (slope ? 1 : 0);
}

/**
 * The one-row stand-in for a curve in a short pane: the caption, the primary
 * curve's shape from the short end to the long, and the selected point's value
 * (the last one when nothing is selected).
 */
export function curveStrip(series: readonly CurveSeries[], formatValue: (value: number) => string, options: {
  caption?: string;
  selectedPointId?: string | null;
  primarySeriesId?: string;
} = {}): ChartStripSpec | null {
  const primary = curvePrimarySeries(series, options.primarySeriesId);
  const points = (primary?.points ?? []).filter((point) => Number.isFinite(point.x)
    && point.value != null && Number.isFinite(point.value)).toSorted((a, b) => a.x - b.x);
  if (!primary || points.length < 2) return null;
  const point = points.find((entry) => entry.id === options.selectedPointId) ?? points.at(-1)!;
  return {
    label: options.caption ?? primary.label,
    values: points.map((entry) => entry.value!),
    value: `${point.label} ${formatValue(point.value!)}`,
    color: primary.color,
  };
}
