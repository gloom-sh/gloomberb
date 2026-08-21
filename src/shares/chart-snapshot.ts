import type { ResolvedSeries } from "../time-series/types";
import type { ChartShareData } from "./payload";

const MAX_POINTS = 500;

function sample<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => (
    values[Math.round(index * (values.length - 1) / (limit - 1))]!
  ));
}

export function buildChartShareData(series: ResolvedSeries[]): ChartShareData | null {
  const sharedSeries = series.flatMap((entry) => {
    const points = entry.points.flatMap((point) => {
      const y = point.value ?? point.close;
      return typeof y === "number" && Number.isFinite(y)
        ? [{ x: point.date.toISOString(), y }]
        : [];
    });
    return points.length > 0 ? [{ name: entry.label, points: sample(points, MAX_POINTS) }] : [];
  });
  if (sharedSeries.length === 0) return null;
  return {
    title: sharedSeries.map((entry) => entry.name).join(" / "),
    series: sharedSeries,
  };
}
