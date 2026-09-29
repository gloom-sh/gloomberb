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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A meeting as the axis and the readout name it: "Oct '26", so the year never reads as a day. */
export function meetingLabel(date: string): string {
  return `${MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? date.slice(5, 7)} '${date.slice(2, 4)}`;
}

/** 25bp moves priced by a meeting: its VS NOW change in steps, `+0.62` for most of one hike. */
export function movesPriced(meeting: RateMeeting): number | null {
  return meeting.changeBps == null || !Number.isFinite(meeting.changeBps) ? null : meeting.changeBps / 25;
}

/**
 * The 25bp moves priced at each meeting on its own, by date: the step in the
 * implied target midpoint since the meeting before, and since today's target
 * range for the next one. It is the same two-outcome reading as the
 * probabilities, so a step of 0.62 is 62% odds of a hike, and for the next
 * meeting it equals `meetingProbability` of the range one move away. A
 * meeting after an unpriced one has no step of its own.
 */
export function meetingMoves(meetings: readonly RateMeeting[]): Map<string, number | null> {
  const moves = new Map<string, number | null>();
  let previous: number | null = 0;
  for (const meeting of [...meetings].sort((a, b) => a.date.localeCompare(b.date))) {
    const priced = movesPriced(meeting);
    moves.set(meeting.date, priced == null || previous == null ? null : priced - previous);
    previous = priced;
  }
  return moves;
}

/** Moves priced, signed to two places: `+0.62`, `-1.20`. */
export function movesText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const text = value.toFixed(2);
  return /[1-9]/.test(text) ? `${value > 0 ? "+" : ""}${text}` : "0.00";
}

/** A meeting's odds of a move, `62% hike`; above 100% more than one move is priced at that meeting. */
export function moveOddsText(step: number | null): string {
  if (step == null || !Number.isFinite(step)) return "--";
  const percent = Math.round(Math.abs(step) * 100);
  return percent === 0 ? "0%" : `${percent}% ${step > 0 ? "hike" : "cut"}`;
}

/** A move in the implied rate, in basis points like the VS NOW column. */
export function rateChangeText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  const text = (value * 100).toFixed(1);
  return /[1-9]/.test(text) ? `${value > 0 ? "+" : ""}${text}bp` : "0.0bp";
}

/**
 * The implied path, then what it is read against: the target range drawn as
 * one reference band, the SEP medians as points, then the look-backs. The
 * legend names them in this order and drops from the end when narrow; the
 * readout still names the look-backs. Paths are steps: the policy rate holds
 * from one meeting to the next.
 */
export function ratePathCurves(data: RatePathPayload, palette?: RatePathPalette): CurveSeries[] {
  const points = data.meetings.map((meeting) => ({
    id: meeting.date, label: meetingLabel(meeting.date), x: Date.parse(meeting.date),
    value: meeting.impliedRate, asOf: meeting.asOf,
  }));
  const series: CurveSeries[] = [{ id: "implied", label: "EFFR", role: "primary", style: "step", asOf: data.asOf, color: palette?.path, points }];
  for (const key of ["targetLower", "targetUpper"] as const) {
    const metric = data.current[key];
    if (metric.value == null) continue;
    series.push({ id: key, label: "Target range", role: "reference", asOf: metric.asOf, color: palette?.band,
      points: points.map((point) => ({ ...point, value: metric.value, asOf: metric.asOf })) });
  }
  const first = points[0]?.x, last = points.at(-1)?.x;
  const projections = data.dotPlot.points.flatMap((point) => {
    if (typeof point.year !== "number") return [];
    const x = Date.parse(`${point.year}-12-31`);
    return first != null && last != null && x >= first && x <= last
      ? [{ id: `sep-${point.year}`, label: `SEP ${point.year}`, x, value: point.rate, asOf: data.dotPlot.asOf }]
      : [];
  });
  if (projections.length) series.push({ id: "sep", label: "SEP median", role: "marker", asOf: data.dotPlot.asOf, color: palette?.projection, points: projections });
  for (const ghost of data.ghosts) {
    if (CHART_GHOST_LABELS.has(ghost.label) && ghost.points.some((point) => point.impliedRate != null)) series.push({
      id: ghost.label, label: ghost.label, role: "ghost", style: "step", asOf: ghost.asOf, color: palette?.ghosts[ghost.label],
      points: ghost.points.map((point) => ({
        id: point.date, label: meetingLabel(point.date), x: Date.parse(point.date),
        value: point.impliedRate, asOf: ghost.asOf,
      })),
    });
  }
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
