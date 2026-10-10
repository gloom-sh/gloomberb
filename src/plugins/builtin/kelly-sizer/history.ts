import type { PricePoint } from "../../../types/financials";
import type { TimeRange } from "../../../time-series/range";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import { getPricePointTimestamp } from "../../../utils/price-history";

/** Sessions in one holding period: a month of trading days. */
export const KELLY_HISTORY_PERIOD_SESSIONS = 21;
export const KELLY_HISTORY_DEFAULT_YEARS = 5;
export const KELLY_HISTORY_MAX_YEARS = 5;
/** Fewer monthly returns than this say too little about a win rate to size on. */
export const KELLY_HISTORY_MIN_PERIODS = 6;

const YEAR_MS = 365.25 * 24 * 60 * 60_000;

/** The binary inputs a ticker's own monthly returns imply over a lookback window. */
export interface KellyHistoryInputs {
  winProbability: number;
  /** Mean return of the up months, as a fraction. */
  upsideReturn: number;
  /** Mean return of the down months, as a negative fraction (0 when none fell). */
  downsideReturn: number;
  /** Up months over all months. */
  wins: number;
  periods: number;
  /** Close the first return starts from, and the last bar, as YYYY-MM-DD. */
  start: string;
  end: string;
  years: number;
}

export function clampKellyHistoryYears(value: unknown): number {
  const years = Math.round(Number(value));
  return Number.isFinite(years) ? Math.min(KELLY_HISTORY_MAX_YEARS, Math.max(1, years)) : KELLY_HISTORY_DEFAULT_YEARS;
}

/** The shortest history range that covers the lookback, so a one-year window never loads five. */
export function kellyHistoryRange(years: number): TimeRange {
  return clampKellyHistoryYears(years) <= 1 ? "1Y" : "5Y";
}

/** The daily closes the History tab and the KELLY report both read. */
export function kellyHistoryRequest(instrument: InstrumentRef, years: number): ChartRequest {
  return { instrument, bufferRange: kellyHistoryRange(years), granularity: "resolution", resolution: "1d" };
}

const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * Win rate, mean gain and mean loss of non-overlapping 21-session returns,
 * counted back from the last daily close so the newest month is complete.
 * Null when the window holds fewer than `KELLY_HISTORY_MIN_PERIODS` of them.
 */
export function estimateKellyHistoryInputs(points: readonly PricePoint[], yearsInput: number): KellyHistoryInputs | null {
  const years = clampKellyHistoryYears(yearsInput);
  const closes = points
    .map((point) => ({ time: getPricePointTimestamp(point), close: point.close }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => left.time - right.time);
  const last = closes.at(-1);
  if (!last) return null;
  const cutoff = last.time - years * YEAR_MS;
  const window = closes.filter((point) => point.time >= cutoff);
  const picks: typeof window = [];
  for (let index = window.length - 1; index >= 0; index -= KELLY_HISTORY_PERIOD_SESSIONS) picks.unshift(window[index]!);
  const returns = picks.slice(1).map((point, index) => point.close / picks[index]!.close - 1);
  if (returns.length < KELLY_HISTORY_MIN_PERIODS) return null;
  const gains = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    winProbability: gains.length / returns.length,
    upsideReturn: mean(gains),
    downsideReturn: mean(losses),
    wins: gains.length,
    periods: returns.length,
    start: dateKey(picks[0]!.time),
    end: dateKey(last.time),
    years,
  };
}
