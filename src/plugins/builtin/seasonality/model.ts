import type { PricePoint } from "../../../types/financials";

export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** Year overlays share one calendar; 2000 is a leap year, so Feb 29 has a place. */
export const OVERLAY_YEAR = 2000;

interface SeasonalityYear {
  year: number;
  /** Month-end to month-end return per month; null before the history starts or after the last close. */
  months: (number | null)[];
  /** Prior year-end close to the year's last close; null for the first year of history. */
  total: number | null;
  /** The year still running: its last month is return to date. */
  partial: boolean;
}

interface SeasonalityMonthStat {
  month: number;
  mean: number | null;
  median: number | null;
  /** Share of years the month closed up. */
  hitRate: number | null;
  count: number;
}

interface SeasonalityPathPoint { date: Date; value: number }

export interface SeasonalityModel {
  symbol: string;
  /** Newest first, limited to the lookback. */
  years: SeasonalityYear[];
  /** Over the lookback's completed months only; the month in progress is left out. */
  months: SeasonalityMonthStat[];
  /** Return since the prior year-end at each month-end of the overlay calendar, newest first. */
  paths: { year: number; points: SeasonalityPathPoint[] }[];
  /** Mean of the completed years' paths at each month-end every one of them reached. */
  averagePath: SeasonalityPathPoint[];
  asOf: Date | null;
}

const monthKey = (year: number, month: number) => year * 12 + month;
const YEAR_START = new Date(Date.UTC(OVERLAY_YEAR, 0, 1));
/** Month-end on the overlay calendar. */
const overlayMonthEnd = (month: number) => new Date(Date.UTC(OVERLAY_YEAR, month + 1, 0));
const DAY_MS = 86_400_000;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function medianGapDays(points: readonly { date: Date }[]): number {
  const gaps = points.slice(1).map((point, index) => (point.date.getTime() - points[index]!.date.getTime()) / DAY_MS);
  return median(gaps) ?? 0;
}

/**
 * Takes the last close in each UTC calendar month, so monthly, weekly and
 * daily bars give the same months. A month's return runs from the previous month's last
 * close to its own, so a month is only returned when the month before it is in
 * the history too.
 */
export function projectSeasonality(history: readonly PricePoint[], options: { symbol: string; lookbackYears: number }): SeasonalityModel {
  // Cached history can come back with ISO strings for dates.
  const sorted = history
    .map((point) => ({ date: new Date(point.date), close: point.close }))
    .filter((point) => Number.isFinite(point.close) && point.close > 0 && Number.isFinite(point.date.getTime()))
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  // A weekly bar is stamped on its Monday but closes on its Friday: file the
  // close under the Friday, or the week that opens a month lands in the month before.
  // ponytail: cadence read from the median gap; a series mixing cadences takes the majority.
  const points = medianGapDays(sorted) >= 5 && medianGapDays(sorted) <= 9
    ? sorted.map((point) => ({ ...point, date: new Date(point.date.getTime() + 4 * DAY_MS) })) : sorted;
  const last = points.at(-1);
  if (!last) return { symbol: options.symbol, years: [], months: [], paths: [], averagePath: [], asOf: null };

  const monthEnd = new Map<number, number>();
  for (const point of points) monthEnd.set(monthKey(point.date.getUTCFullYear(), point.date.getUTCMonth()), point.close);

  const lastYear = last.date.getUTCFullYear();
  // The month of the last bar is still running unless it is December: monthly
  // bars are stamped at the month's start, so their date cannot say more.
  const complete = last.date.getUTCMonth() === 11;
  const runningMonthKey = complete ? null : monthKey(lastYear, last.date.getUTCMonth());
  const firstYear = Math.max(points[0]!.date.getUTCFullYear(), lastYear - Math.max(1, options.lookbackYears) + 1);
  const years: SeasonalityYear[] = [];
  const paths: SeasonalityModel["paths"] = [];
  /** Per completed year, return since the prior year-end at each month-end. */
  const completedCumulative: (number | null)[][] = [];
  for (let year = lastYear; year >= firstYear; year--) {
    const closes = MONTH_LABELS.map((_, month) => monthEnd.get(monthKey(year, month)) ?? null);
    const months = closes.map((close, month) => {
      const previous = monthEnd.get(monthKey(year, month) - 1);
      return close != null && previous != null ? close / previous - 1 : null;
    });
    const base = monthEnd.get(monthKey(year, 0) - 1);
    const cumulative = closes.map((close) => close != null && base != null ? close / base - 1 : null);
    years.push({ year, months, partial: year === lastYear && !complete, total: cumulative.findLast((value) => value != null) ?? null });
    if (base == null) continue;
    paths.push({ year, points: [{ date: YEAR_START, value: 0 },
      // The month still running is drawn at its latest bar, not at a month-end still to come.
      ...cumulative.flatMap((value, month) => value == null ? [] : [{ value, date: monthKey(year, month) === runningMonthKey
        ? new Date(Math.min(overlayMonthEnd(month).getTime(), Date.UTC(OVERLAY_YEAR, month, last.date.getUTCDate()))) : overlayMonthEnd(month) }])] });
    // The running year is drawn but left out of the average.
    if (year !== lastYear || complete) completedCumulative.push(cumulative);
  }

  const months = MONTH_LABELS.map((_, month): SeasonalityMonthStat => {
    const values = years.flatMap((row) => monthKey(row.year, month) === runningMonthKey || row.months[month] == null ? [] : [row.months[month]!]);
    return { month, count: values.length, mean: mean(values), median: median(values),
      hitRate: values.length ? values.filter((value) => value > 0).length / values.length : null };
  });

  // A year missing a month-end (a listing that started mid-year) would bend the mean, so a month needs every year.
  const averagePath = completedCumulative.length ? [{ date: YEAR_START, value: 0 }, ...MONTH_LABELS.flatMap((_, month) => {
    const values = completedCumulative.map((cumulative) => cumulative[month]);
    return values.every((value) => value != null) ? [{ date: overlayMonthEnd(month), value: mean(values as number[])! }] : [];
  })] : [];

  return { symbol: options.symbol, years, months, paths, averagePath, asOf: last.date };
}
