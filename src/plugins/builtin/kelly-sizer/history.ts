import type { PricePoint } from "../../../types/financials";
import type { TimeRange } from "../../../time-series/range";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import { dailyBarDate, getPricePointTimestamp } from "../../../utils/price-history";
import { sessionCalendarTimeZone } from "../../../market-data/market/freshness";
import { zonedDateTimeParts } from "../../../utils/zoned-date-time";

const DAY_MS = 86_400_000;

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

/** The month now on the venue's calendar, as YYYY-MM: a coin's, and a venue without a known zone's, in UTC. */
function venueMonth(now: number, exchange: string): { year: number; month: number } {
  const { year, month } = zonedDateTimeParts(now, sessionCalendarTimeZone(exchange) ?? "UTC");
  return { year, month };
}

/**
 * The daily closes the History tab and the KELLY report both read: from the
 * first day of the month before the window's first month, so each of the
 * `years` × 12 months has the close it is measured from, to the end of the
 * UTC day, so a day keeps one request. A trailing five-year range starts days
 * into that month and gave 59 returns.
 */
export function kellyHistoryRequest(instrument: InstrumentRef, years: number, now = Date.now()): ChartRequest {
  const lookback = clampKellyHistoryYears(years);
  const { year, month } = venueMonth(now, instrument.exchange ?? "");
  return {
    instrument,
    // The range the request falls back to where a source has no dated history.
    bufferRange: lookback <= 1 ? "1Y" : "5Y",
    granularity: "detail",
    barSize: "1d",
    startDate: new Date(Date.UTC(year, month - 1 - (lookback * 12 + 1), 1)),
    endDate: new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS),
  };
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
