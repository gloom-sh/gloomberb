import { scalarPointValue } from "./alignment";
import { observationDate } from "./price-comparison";
import type { ResolvedSeries, TimeSeriesPoint } from "./types";

/**
 * Where a study measures from and to, per input series: the session a price
 * comparison starts its legs at and the one it ends them at. Null ends take
 * the series' own first or last observation.
 */
export interface StudyAnchor {
  start: number | null;
  end: number | null;
}

/** A daily objective a fund can have: 3 (TQQQ), -3 (SQQQ), 1.5 (UVXY), -0.5. */
export function isLeverageFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0 && Math.abs(value) <= 5;
}

/** `3×`, `-3×`, `1.5×`: a factor as sponsors write it, without float noise. */
export function leverageFactorLabel(factor: number): string {
  return `${Number(factor.toFixed(4))}×`;
}

/** What a series is of, for a label: its listing's symbol (`QQQ`), else its label. */
export function leverageSymbol(series: Pick<ResolvedSeries, "listing" | "label">): string {
  return series.listing?.symbol ?? series.label;
}

interface SessionClose {
  day: string;
  point: TimeSeriesPoint;
  close: number;
}

/** A series' closes from its anchor to its end, one per session, oldest first. */
export function sessionCloses(series: ResolvedSeries, anchor: StudyAnchor | undefined): SessionClose[] {
  const closes = new Map<string, SessionClose>();
  for (const point of series.points) {
    const time = point.date.getTime();
    const close = scalarPointValue(point);
    if (close === null || !Number.isFinite(close) || close <= 0) continue;
    if (anchor?.start != null && time < anchor.start) continue;
    if (anchor?.end != null && time > anchor.end) continue;
    closes.set(observationDate(time, series), { day: observationDate(time, series), point, close });
  }
  return [...closes.values()].sort((left, right) => left.day.localeCompare(right.day));
}

/**
 * The line a daily objective draws, as growth of 1 from the first close:
 * each session `factor` times the index fund's return that session,
 * compounded. TQQQ seeks 3× QQQ's return each day, not over a month.
 */
export function dailyLeverageGrowth(closes: readonly number[], factor: number): number[] {
  const growth: number[] = [];
  for (let index = 0; index < closes.length; index += 1) {
    growth.push(index === 0 ? 1 : growth[index - 1]! * (1 + factor * (closes[index]! / closes[index - 1]! - 1)));
  }
  return growth;
}

/** Each session's figures, as returns from the first in percent. */
export interface LeverageDecayPoint {
  day: string;
  point: TimeSeriesPoint;
  /** The fund's own return. */
  fund: number;
  /** The `factor`× daily line's return. */
  daily: number;
  /** `factor` times the index fund's return over the period. */
  period: number;
}

/**
 * A leveraged fund against its objective, session by session from the first
 * both have a close on: its return, the `factor`× daily line's, and `factor`
 * times the index fund's return over the period. The line compounds over
 * every session the index fund has; the figures are read on the sessions the
 * fund has too.
 */
export function leverageDecayPoints(fund: readonly SessionClose[], index: readonly SessionClose[], factor: number): LeverageDecayPoint[] {
  const fundByDay = new Map(fund.map((entry) => [entry.day, entry]));
  const start = index.findIndex((entry) => fundByDay.has(entry.day));
  if (start < 0) return [];
  const legs = index.slice(start);
  const growth = dailyLeverageGrowth(legs.map((entry) => entry.close), factor);
  const fundStart = fundByDay.get(legs[0]!.day)!.close;
  const indexStart = legs[0]!.close;
  return legs.flatMap((entry, position) => {
    const own = fundByDay.get(entry.day);
    return own ? [{
      day: entry.day,
      point: own.point,
      fund: (own.close / fundStart - 1) * 100,
      daily: (growth[position]! - 1) * 100,
      period: factor * (entry.close / indexStart - 1) * 100,
    }] : [];
  });
}
