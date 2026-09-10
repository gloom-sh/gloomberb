import type { DatedObservation } from "../shared/series-cache";

/**
 * How a raw FRED series becomes the number people quote. An index level like CPI
 * is meaningless on its own; the year-over-year change is the statistic.
 */
export type StatTransform =
  | "level"
  | "yoy"
  | "mom"
  | "qoq-annualized"
  | "change";

export interface StatPoint {
  date: string;
  value: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Infers cadence from the median gap between prints, so a transform does not have
 * to be told whether a series is daily, weekly, monthly or quarterly.
 */
export function periodsPerYear(observations: readonly DatedObservation[]): number {
  const dates = observations
    .filter((entry) => entry.value != null)
    .map((entry) => Date.parse(entry.date))
    .filter((value) => Number.isFinite(value));
  if (dates.length < 3) return 12;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i += 1) {
    const gap = (dates[i]! - dates[i - 1]!) / MS_PER_DAY;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 12;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;

  if (median <= 4) return 252;
  if (median <= 10) return 52;
  if (median <= 45) return 12;
  if (median <= 135) return 4;
  return 1;
}

/** Applies a transform, dropping the leading points it cannot look back from. */
export function applyTransform(
  observations: readonly DatedObservation[],
  transform: StatTransform,
): StatPoint[] {
  const clean = observations
    .filter((entry): entry is { date: string; value: number } =>
      entry.value != null && Number.isFinite(entry.value) && Number.isFinite(Date.parse(entry.date)))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (clean.length === 0) return [];

  if (transform === "level") {
    return clean.map((entry) => ({ date: entry.date, value: entry.value }));
  }

  const perYear = transform === "qoq-annualized" ? 4 : periodsPerYear(clean);
  const lag = transform === "yoy" ? perYear : 1;
  // FRED monthly/quarterly observations represent calendar periods. Removing a
  // missing month before applying a positional lag turns y/y into a 13-month
  // change, or reports a two-quarter GDP move as one quarter's annualized rate.
  const calendarCadence = perYear === 12 || perYear === 4 || perYear === 1;
  const byMonth = new Map(clean.map((point) => [point.date.slice(0, 7), point]));
  const lagMonths = transform === "yoy" ? 12 : 12 / perYear;
  const out: StatPoint[] = [];
  for (let i = 0; i < clean.length; i += 1) {
    const now = clean[i]!;
    const before = calendarCadence
      ? byMonth.get(new Date(Date.UTC(Number(now.date.slice(0, 4)), Number(now.date.slice(5, 7)) - 1 - lagMonths, 1)).toISOString().slice(0, 7))
      : clean[i - lag];
    if (!before) continue;
    if (transform === "change") {
      out.push({ date: now.date, value: now.value - before.value });
      continue;
    }
    if (before.value === 0) continue;
    const ratio = now.value / before.value;
    if (transform === "qoq-annualized") {
      // A quarterly move stated as the annual rate it implies, as the BEA reports it.
      if (ratio <= 0) continue;
      out.push({ date: now.date, value: (Math.pow(ratio, perYear) - 1) * 100 });
      continue;
    }
    out.push({ date: now.date, value: (ratio - 1) * 100 });
  }
  return out;
}
