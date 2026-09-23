import type { ResolvedSeries } from "../../../time-series/types";
import { scalarPoint, staticSeries } from "./series";

export interface ScatterTrail {
  id: string;
  label: string;
  color: string;
  points: Array<{ x: number; y: number; date: string }>;
}
const SCALE = 1_000_000;
export function buildTrailChart(
  trails: readonly ScatterTrail[],
  center: number,
  axisColor: string,
) {
  const valid = trails.map((trail) => ({
    ...trail,
    points: trail.points.filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    ),
  }));
  const points = valid.flatMap((trail) => trail.points);
  const xRadius =
    Math.max(1, ...points.map((point) => Math.abs(point.x - center))) * 1.12;
  const yRadius =
    Math.max(1, ...points.map((point) => Math.abs(point.y - center))) * 1.12;
  const min = center - xRadius,
    max = center + xRadius;
  const toDate = (x: number) => new Date(Math.round((x - min) * SCALE));
  const series: ResolvedSeries[] = [
    staticSeries(
      [scalarPoint(toDate(min), center), scalarPoint(toDate(max), center)],
      { id: "horizontal-origin", color: axisColor, calendarSpaced: true },
    ),
    staticSeries(
      [
        scalarPoint(toDate(center), center - yRadius),
        scalarPoint(new Date(toDate(center).getTime() + 1), center + yRadius),
      ],
      { id: "vertical-origin", color: axisColor, calendarSpaced: true },
    ),
  ];
  for (const trail of valid) {
    // A time-series chart sorts x. Separate edges preserve loops and direction changes.
    for (let index = 1; index < trail.points.length; index++) {
      const a = trail.points[index - 1]!,
        b = trail.points[index]!;
      const ends = [a, b].sort((left, right) => left.x - right.x);
      const dates = ends.map((point) => toDate(point.x));
      // A vertical edge needs distinct integer timestamps to survive date deduplication.
      if (dates[0]!.getTime() === dates[1]!.getTime())
        dates[1] = new Date(dates[0]!.getTime() + 1);
      series.push(
        staticSeries(
          ends.map((point, i) => scalarPoint(dates[i]!, point.y)),
          {
            id: `${trail.id}:edge:${index}`,
            label: trail.label,
            color: trail.color,
            calendarSpaced: true,
          },
        ),
      );
    }
    const last = trail.points.at(-1);
    if (last)
      series.push(
        staticSeries([scalarPoint(toDate(last.x), last.y)], {
          id: `${trail.id}:head`,
          label: trail.label,
          color: trail.color,
          style: "points",
          calendarSpaced: true,
        }),
      );
  }
  return {
    series,
    min,
    max,
    toDate,
    fromDate: (date: Date) => min + date.getTime() / SCALE,
  };
}

/**
 * Round gridline labels across the strength axis (90, 95, 100, ...), as the
 * value axis has. Only interior multiples are labelled: the domain's own edges
 * are arbitrary and an edge label is pinned against the pane border.
 */
export function trailAxisTicks(min: number, max: number): Array<{ ratio: number; label: string }> {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [];
  const raw = span / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Number(([1, 2, 2.5, 5, 10].find((factor) => factor * power >= raw - 1e-9)! * power).toPrecision(12));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (String(step).includes("25") ? 1 : 0));
  const ticks: Array<{ ratio: number; label: string }> = [];
  for (let index = Math.ceil(min / step); index * step <= max; index++) {
    const value = Number((index * step).toPrecision(12));
    const ratio = (value - min) / span;
    if (ratio > 0.03 && ratio < 0.97) ticks.push({ ratio, label: value.toFixed(decimals) });
  }
  return ticks;
}
