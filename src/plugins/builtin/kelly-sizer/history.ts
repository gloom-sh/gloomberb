import type { PricePoint } from "../../../types/financials";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import { dailyBarDate, getPricePointTimestamp } from "../../../utils/price-history";
import { calendarMonthReturnsRequest, trailingDailyClosesRequest, venueMonth } from "../../../time-series/calendar-month-returns";

export const KELLY_HISTORY_DEFAULT_YEARS = 5;
export const KELLY_HISTORY_MAX_YEARS = 5;
/** Fewer monthly returns than this say too little about a win rate to size on. */
export const KELLY_HISTORY_MIN_PERIODS = 6;

/** The binary inputs a ticker's own monthly returns imply over a lookback window. */
export interface KellyHistoryInputs {
  winProbability: number;
  /** Mean return of the up months, as a fraction. */
  upsideReturn: number;
  /** Mean return of the down months, as a negative fraction. */
  downsideReturn: number;
  /** Up months over all months. */
  wins: number;
  periods: number;
  /** The month-end close the first return starts from, and the one the last return ends on, as YYYY-MM-DD. */
  start: string;
  end: string;
  /** The newest daily close read, which a month in progress may follow, as YYYY-MM-DD. */
  latest: string;
  years: number;
}

export function clampKellyHistoryYears(value: unknown): number {
  const years = Math.round(Number(value));
  return Number.isFinite(years) ? Math.min(KELLY_HISTORY_MAX_YEARS, Math.max(1, years)) : KELLY_HISTORY_DEFAULT_YEARS;
}

/** KELLY's dated daily closes (`calendarMonthReturnsRequest`) over a lookback clamped to its one to five years. */
export function kellyHistoryRequest(instrument: InstrumentRef, years: number, now = Date.now()): ChartRequest {
  return calendarMonthReturnsRequest(instrument, clampKellyHistoryYears(years), now);
}

/** The trailing range the History tab and the KELLY report both fall back to without dated closes. */
export function kellyTrailingHistoryRequest(instrument: InstrumentRef, years: number): ChartRequest {
  return trailingDailyClosesRequest(instrument, clampKellyHistoryYears(years));
}

/**
 * Win rate, mean gain and mean loss of calendar-month returns: each month's
 * last close against the month before's, for every asset, so a coin that
 * trades every day and a stock that trades on weekdays are sized on the same
 * months. A month counts once it has ended (`now` is in a later month), so a
 * month in progress is never a return; the newest `years` × 12 complete
 * months are used. Days and the month now are the venue's (`exchange`), a
 * coin's UTC, so a month that has ended in Tokyo counts before it has in UTC. Null
 * when that leaves fewer than `KELLY_HISTORY_MIN_PERIODS` returns, or every
 * one of them is a gain, or every one of them is a loss.
 */
export function estimateKellyHistoryInputs(
  points: readonly PricePoint[],
  yearsInput: number,
  options: { exchange?: string; now?: number } = {},
): KellyHistoryInputs | null {
  const years = clampKellyHistoryYears(yearsInput);
  const now = venueMonth(options.now ?? Date.now(), options.exchange ?? "");
  const thisMonth = `${now.year}-${String(now.month).padStart(2, "0")}`;
  const monthEnds = new Map<string, { day: string; close: number }>();
  const closes = points
    .map((point) => ({ time: getPricePointTimestamp(point), close: point.close }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => left.time - right.time);
  for (const point of closes) {
    const day = dailyBarDate(point.time, options.exchange ?? "");
    // Sorted oldest first, so each month keeps its last close.
    if (day.slice(0, 7) < thisMonth) monthEnds.set(day.slice(0, 7), { day, close: point.close });
  }
  const picks = [...monthEnds.values()].slice(-(years * 12 + 1));
  const returns = picks.slice(1).map((point, index) => point.close / picks[index]!.close - 1);
  if (returns.length < KELLY_HISTORY_MIN_PERIODS) return null;
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  if (gains.length === 0 || losses.length === 0) return null;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    winProbability: gains.length / returns.length,
    upsideReturn: mean(gains),
    downsideReturn: mean(losses),
    wins: gains.length,
    periods: returns.length,
    start: picks[0]!.day,
    end: picks.at(-1)!.day,
    latest: dailyBarDate(closes.at(-1)!.time, options.exchange ?? ""),
    years,
  };
}
