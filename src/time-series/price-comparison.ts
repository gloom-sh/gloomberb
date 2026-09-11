import { scalarPointValue } from "./alignment";
import { getTimeSeriesField } from "./field-catalog";
import type { ChartSpec, ResolvedSeries, TimeSeriesPoint } from "./types";
import type { ManualChartResolution } from "./resolution";
import { zonedDateTimeParts } from "../utils/zoned-date-time";

export const PRICE_COMPARISON_BASIS = "Price returns in each listing's currency; cash distributions and FX conversion excluded.";

export interface PriceComparison {
  seriesIds: string[];
  /** Display envelope; each leg retains its exact source endpoints below. */
  start: number | null;
  end: number | null;
  notice: string;
  alignment?: "session-date" | "timestamp";
  sourceBounds?: Record<string, { start: number; end: number }>;
}

function observationDate(time: number, series: ResolvedSeries): string {
  const date = new Date(time);
  // Date-only provider bars are represented as UTC midnight throughout the app.
  // Timestamped bars use the exchange's local calendar; crypto uses UTC.
  if (time % 86_400_000 === 0 || !series.timeBasis) return date.toISOString().slice(0, 10);
  const { year, month, day } = zonedDateTimeParts(time, series.timeBasis.timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Date-only research windows select local sessions; runtime timestamps remain exact. */
export function priceObservationWindowFilter(
  series: ResolvedSeries,
  bounds: { start: number | null; end: number | null },
  resolution: ManualChartResolution | "auto",
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null,
): (time: number) => boolean {
  const calendarBars = resolution === "1d" || resolution === "1wk" || resolution === "1mo";
  const calendarWindow = calendarBars && dateWindow
    && /^\d{4}-\d{2}-\d{2}$/.test(dateWindow.start)
    && /^\d{4}-\d{2}-\d{2}$/.test(dateWindow.end) ? dateWindow : null;
  return (time) => {
    if (!Number.isFinite(time)) return false;
    const key = calendarWindow ? observationDate(time, series) : null;
    return key !== null
      ? key >= calendarWindow!.start && key <= calendarWindow!.end
      : (bounds.start === null || time >= bounds.start) && (bounds.end === null || time <= bounds.end);
  };
}

export function priceComparisonBoundsForSeries(series: ResolvedSeries, comparison: PriceComparison | null) {
  return comparison?.sourceBounds?.[series.id] ?? comparison;
}

function displayDate(time: number): string {
  const iso = new Date(time).toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.replace("T", " ").replace(".000Z", " UTC");
}

/** Comparable normalized closing-price legs share observed endpoints. Other chart meanings are unchanged. */
export function priceComparisonSeriesIds(spec: ChartSpec): string[] | null {
  if (spec.viewport.maxPoints !== undefined) return null;
  const visible = spec.series.filter((entry) => entry.visible !== false);
  if (visible.length < 2 || !visible.every((entry) => {
    const field = entry.source.kind === "security" ? getTimeSeriesField(entry.source.fieldId)?.id : null;
    return (field === "market.close" || field === "market.ohlcv")
      && (entry.transform === "percent" || entry.transform === "index100")
      && entry.transform === visible[0]!.transform
      && entry.panelId === visible[0]!.panelId
      && entry.source.kind === "security" && visible[0]!.source.kind === "security"
      && (entry.source.period ?? "auto") === (visible[0]!.source.period ?? "auto");
  })) return null;
  return visible.map((entry) => entry.id);
}

export function resolvePriceComparison(
  spec: ChartSpec,
  series: readonly ResolvedSeries[],
  bounds: { start: number | null; end: number | null },
  resolution: ManualChartResolution | "auto" = spec.viewport.resolution,
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null = spec.viewport.dateWindow,
): PriceComparison | null {
  const seriesIds = priceComparisonSeriesIds(spec);
  if (!seriesIds) return null;
  const byId = new Map(series.map((entry) => [entry.id, entry]));
  const calendarBars = resolution === "1d" || resolution === "1wk" || resolution === "1mo";
  const observations = seriesIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) return new Map<string, TimeSeriesPoint>();
    const inWindow = priceObservationWindowFilter(entry, bounds, resolution, dateWindow);
    return new Map(entry.points.flatMap((point) => {
      const time = point.date.getTime();
      if (!inWindow(time) || scalarPointValue(point) === null) return [];
      return [[calendarBars ? observationDate(time, entry) : String(time), point] as const];
    }));
  });
  const shared = [...observations[0]!.keys()].filter((key) => observations.every((points) => points.has(key)))
    .sort((a, b) => calendarBars ? a.localeCompare(b) : Number(a) - Number(b));
  const start = shared.find((key) => observations.every((points) => {
    const point = points.get(key);
    return point && scalarPointValue(point) !== 0;
  }));
  const end = shared.at(-1);
  if (start === undefined || end === undefined || start === end) return {
    seriesIds, start: null, end: null,
    notice: `${PRICE_COMPARISON_BASIS} Comparison unavailable: need two shared dates and a nonzero baseline.`,
  };
  const sourceBounds = Object.fromEntries(seriesIds.map((id, index) => [id, {
    start: observations[index]!.get(start)!.date.getTime(),
    end: observations[index]!.get(end)!.date.getTime(),
  }]));
  return {
    seriesIds,
    start: Math.min(...Object.values(sourceBounds).map((range) => range.start)),
    end: Math.max(...Object.values(sourceBounds).map((range) => range.end)),
    alignment: calendarBars ? "session-date" : "timestamp",
    sourceBounds,
    notice: calendarBars
      ? `${PRICE_COMPARISON_BASIS} Shared calendar dates: ${start} to ${end}; market session times may differ.`
      : `${PRICE_COMPARISON_BASIS} Shared observations: ${displayDate(Number(start))} to ${displayDate(Number(end))}.`,
  };
}

/** Clip only compared legs; raw observations and study inputs stay available in the source cache. */
export function clipPriceComparison(series: ResolvedSeries, comparison: PriceComparison | null): ResolvedSeries {
  if (!comparison?.seriesIds.includes(series.id)) return series;
  const { start, end } = priceComparisonBoundsForSeries(series, comparison)!;
  return {
    ...series,
    // The legend must describe the compared endpoint, not a newer one-leg quote.
    latestChangePercent: undefined,
    points: start === null || end === null ? [] : series.points.filter((point) => (
      point.date.getTime() >= start && point.date.getTime() <= end
    )),
  };
}
