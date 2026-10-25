import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { formatCompositeSeriesValue } from "./format";
import type { CompositeViewportRange } from "./interactions";
import type { CompositeChartLevel, CompositeChartLevels } from "./levels";

/** Population statistics of the finite observations actually in the window. */
export function compositeRangeStatistics(points: readonly TimeSeriesPoint[], viewport: CompositeViewportRange) {
  const start = viewport.start.getTime();
  const end = viewport.end.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  let count = 0;
  let mean = 0;
  let squaredDeviations = 0;
  for (const point of points) {
    const time = point.date.getTime();
    const value = Number.isFinite(point.value) ? point.value : point.close;
    if (!Number.isFinite(time) || time < start || time > end
      || typeof value !== "number" || !Number.isFinite(value)) continue;
    count += 1;
    // Welford's update avoids subtracting nearly equal squared sums when
    // valuations are tightly clustered around a large level.
    const delta = value - mean;
    mean += delta / count;
    squaredDeviations += delta * (value - mean);
  }
  if (!count || !Number.isFinite(mean) || !Number.isFinite(squaredDeviations)) return null;
  return { count, mean, standardDeviation: Math.sqrt(Math.max(0, squaredDeviations / count)) };
}

/** Read-only levels share the chart's axis labels, vector, Kitty and text paths. */
export function compositeRangeStatisticsLevels(
  series: ResolvedSeries | undefined,
  viewport: CompositeViewportRange | null,
  color: string,
  formatValue: (value: number, series: ResolvedSeries) => string = formatCompositeSeriesValue,
): CompositeChartLevels | null {
  if (!series || series.hidden || !viewport) return null;
  const statistics = compositeRangeStatistics(series.points, viewport);
  if (!statistics) return null;
  const { mean, standardDeviation } = statistics;
  const guides = [
    { id: "mean", label: "Avg", value: mean, dashed: false },
    { id: "upper", label: "+1σ", value: mean + standardDeviation, dashed: true },
    { id: "lower", label: "−1σ", value: mean - standardDeviation, dashed: true },
  ];
  const items: CompositeChartLevel[] = [];
  for (const guide of guides) {
    // A constant window (including one observation) has only its mean.
    if (!Number.isFinite(guide.value) || items.some((item) => item.value === guide.value)) continue;
    items.push({
      id: `range-statistics:${series.id}:${guide.id}`,
      value: guide.value,
      color,
      dashed: guide.dashed,
      axisLabel: `${guide.label} ${formatValue(guide.value, series)}`,
      prioritizeAxisLabel: true,
      editable: false,
      actionable: false,
    });
  }
  return { seriesId: series.id, items };
}
