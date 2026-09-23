import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
import type { CurveSeries } from "../../../components/chart/curve/model";

export function rateText(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "--" : `${value.toFixed(2)}%`;
}

export function percentileText(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "pctl --" : `${value.toFixed(0)} pctl 1Y`;
}

/**
 * Ghosts drawn on the path chart. A path priced a year ago sits in a different
 * regime and drags the axis away from the current curve, the target band and
 * the near ghosts; its context survives in the 1Y percentiles and the slope
 * readout instead.
 */
export const CHART_GHOST_LABELS: ReadonlySet<string> = new Set(["1W", "1M"]);

/** Colours by role, so the target band never shares the implied path's colour. Ghosts are keyed by look-back. */
export interface RatePathPalette { path: string; ghosts: Readonly<Record<string, string>>; band: string; projection: string }

export function ratePathCurves(data: RatePathPayload, palette?: RatePathPalette): CurveSeries[] {
  const points = data.meetings.map((meeting) => ({
    id: meeting.date, label: meeting.date.slice(5), x: Date.parse(meeting.date),
    value: meeting.impliedRate, asOf: meeting.asOf,
  }));
  const series: CurveSeries[] = [{ id: "implied", label: "Implied EFFR", asOf: data.asOf, color: palette?.path, points }];
  for (const ghost of data.ghosts) {
    if (CHART_GHOST_LABELS.has(ghost.label) && ghost.points.some((point) => point.impliedRate != null)) series.push({
      id: ghost.label, label: ghost.label, asOf: ghost.asOf, color: palette?.ghosts[ghost.label],
      points: ghost.points.map((point) => ({
        id: point.date, label: point.date.slice(5), x: Date.parse(point.date),
        value: point.impliedRate, asOf: ghost.asOf,
      })),
    });
  }
  for (const key of ["targetLower", "targetUpper"] as const) {
    const metric = data.current[key];
    if (metric.value == null) continue;
    series.push({ id: key, label: key === "targetLower" ? "Target floor" : "Target ceiling", asOf: metric.asOf, color: palette?.band,
      points: points.map((point) => ({ ...point, value: metric.value, asOf: metric.asOf })) });
  }
  const first = points[0]?.x, last = points.at(-1)?.x;
  const projections = data.dotPlot.points.flatMap((point) => {
    if (typeof point.year !== "number") return [];
    const date = `${point.year}-12-31`;
    const x = Date.parse(date);
    // The label doubles as an axis tick between meeting dates, so it reads as a date.
    return first != null && last != null && x >= first && x <= last
      ? [{ id: `sep-${point.year}`, label: date.slice(5), x, value: point.rate, asOf: data.dotPlot.asOf }]
      : [];
  });
  if (projections.length) series.push({ id: "sep", label: "SEP median", asOf: data.dotPlot.asOf, style: "points", color: palette?.projection, points: projections });
  return series;
}

/** Unknown outcomes remain empty; a missing model never becomes a zero probability. */
export function meetingProbability(meeting: RateMeeting, target: number): number | null {
  if (meeting.impliedRate == null || meeting.probabilities.length === 0) return null;
  const outcome = meeting.probabilities.find((entry) => Math.abs(entry.targetMidpoint - target) < 1e-8);
  if (!outcome) return 0;
  return Number.isFinite(outcome.probability) && outcome.probability >= 0 && outcome.probability <= 1
    ? outcome.probability : null;
}

export function probabilityTargets(meetings: readonly RateMeeting[]): number[] {
  return [...new Set(meetings.flatMap((meeting) => meeting.probabilities.map((point) => point.targetMidpoint)))]
    .filter(Number.isFinite).sort((a, b) => a - b);
}
