import type { PricePoint } from "../../../../types/financials";
import {
  mergePriceHistoryIntegrity,
  pricePointIntegrity,
  type PriceHistoryIntegrity,
} from "../../../../utils/price-history-integrity";

export const VOLATILITY_TRADING_DAYS = 252;
export const REALIZED_VOLATILITY_WINDOWS = [10, 20, 30, 60, 90, 180, 260] as const;

export const REALIZED_VOLATILITY_ESTIMATORS = [
  "close-to-close", "parkinson", "garman-klass", "rogers-satchell", "yang-zhang",
] as const;
export type RealizedVolatilityEstimator = typeof REALIZED_VOLATILITY_ESTIMATORS[number];

export function isRealizedVolatilityEstimator(value: unknown): value is RealizedVolatilityEstimator {
  return REALIZED_VOLATILITY_ESTIMATORS.some((estimator) => estimator === value);
}

export type RealizedVolatilityUnavailableReason =
  | "invalid-window"
  | "invalid-date"
  | "insufficient-history"
  | "inconsistent-ohlc"
  | "missing-close"
  | "missing-ohlc"
  | "invalid-variance";

export interface RealizedVolatilityResult {
  /** Annualized decimal volatility, so 0.2 means 20%. */
  value: number | null;
  reason?: RealizedVolatilityUnavailableReason;
  integrity?: PriceHistoryIntegrity;
}

export interface RollingRealizedVolatilityOptions {
  windows?: readonly number[];
  estimator?: RealizedVolatilityEstimator;
}

export interface RollingRealizedVolatilityPoint {
  date: Date;
  /** Values stay null across incomplete or rejected windows. */
  values: Readonly<Record<number, number | null>>;
}

export interface VolatilityConeOptions extends RollingRealizedVolatilityOptions {
  /** Calendar years ending on the last supplied observation, not on today's date. */
  lookbackYears?: 1 | 2;
}

export interface VolatilityConeStatistics {
  window: number;
  current: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  /** Midrank percentile on a 0 to 100 scale; a constant history has rank 50. */
  percentile: number | null;
  sampleSize: number;
}

/**
 * Consumer guard for daily-data requests whose provider may have fallen back to
 * intraday or weekly bars. The estimators themselves remain general n-session
 * calculations. This detects cadence contradictions, not missing market sessions.
 */
export function realizedVolatilityCadenceIssue(points: readonly Pick<PricePoint, "date">[]): string | null {
  const timestamps = new Set<number>();
  for (const point of points) {
    const time = new Date(point.date).getTime();
    if (!Number.isFinite(time)) return "Realized volatility unavailable: invalid history date";
    timestamps.add(time);
  }
  const history = [...timestamps].sort((a, b) => a - b);
  const days = new Set<number>();
  const gaps: number[] = [];
  for (let index = 0; index < history.length; index += 1) {
    const time = history[index]!;
    const day = Math.floor(time / 86_400_000);
    if (days.has(day)) return "Daily history unavailable: intraday observations returned";
    days.add(day);
    if (index > 0) gaps.push(time - history[index - 1]!);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[middle]! : (gaps[middle - 1]! + gaps[middle]!) / 2;
  return median >= 5 * 86_400_000 ? "Daily history unavailable: observed cadence is weekly or slower" : null;
}

interface Observation {
  time: number;
  close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  integrity?: PriceHistoryIntegrity;
}

function positiveLog(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.log(value) : null;
}

/** Corrections replace the same date before selection, matching the options monitor. */
function observations(points: readonly PricePoint[]): Observation[] | null {
  const dates = new Map<number, PricePoint>();
  for (const point of points) {
    const time = new Date(point.date).getTime();
    if (!Number.isFinite(time)) return null;
    dates.set(time, point);
  }
  return [...dates.entries()].sort(([a], [b]) => a - b).map(([time, point]) => ({
    time,
    close: positiveLog(point.close),
    open: positiveLog(point.open),
    high: positiveLog(point.high),
    low: positiveLog(point.low),
    integrity: pricePointIntegrity(point),
  }));
}

function validWindow(window: number): boolean {
  return Number.isInteger(window) && window >= 2;
}

/** Welford's centered variance avoids cancellation when the return drift is large. */
function sampleVariance(values: readonly number[]): number {
  let mean = 0;
  let squaredDeviations = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const delta = value - mean;
    mean += delta / (index + 1);
    squaredDeviations += delta * (value - mean);
  }
  return squaredDeviations / (values.length - 1);
}

function unavailable(reason: RealizedVolatilityUnavailableReason): RealizedVolatilityResult {
  return { value: null, reason };
}

function estimateWindow(
  history: readonly Observation[],
  end: number,
  window: number,
  estimator: RealizedVolatilityEstimator,
): RealizedVolatilityResult {
  if (!validWindow(window)) return unavailable("invalid-window");
  const previousCloseRequired = estimator === "close-to-close" || estimator === "yang-zhang";
  const start = end - window + 1;
  const first = start - (previousCloseRequired ? 1 : 0);
  // Validate selected observations before calculating. Removing one would bridge a gap.
  // Even an incomplete window retains diagnostics for its rejected source rows.
  const rejected: PriceHistoryIntegrity[] = [];
  for (let index = Math.max(0, first); index <= end; index += 1) {
    const integrity = history[index]!.integrity;
    if (integrity) rejected.push(integrity);
  }
  if (rejected.length > 0) {
    return { value: null, reason: "inconsistent-ohlc", integrity: mergePriceHistoryIntegrity(...rejected) };
  }
  for (let index = Math.max(0, first); index <= end; index += 1) {
    const point = history[index]!;
    if (point.close === null) return unavailable("missing-close");
    // The predecessor supplies only its close, including for Yang-Zhang.
    if (estimator !== "close-to-close" && index >= start
      && (point.high === null || point.low === null || (estimator !== "parkinson" && point.open === null))) {
      return unavailable("missing-ohlc");
    }
  }
  if (first < 0) return unavailable("insufficient-history");

  const returns: number[] = [];
  const overnightReturns: number[] = [];
  let rangeSum = 0;
  for (let index = start; index <= end; index += 1) {
    const point = history[index]!;
    const close = point.close!;
    if (estimator === "close-to-close") {
      // Subtract logs: even two finite prices can have an overflowing ratio.
      returns.push(close - history[index - 1]!.close!);
      continue;
    }
    const high = point.high!;
    const low = point.low!;
    const range = high - low;
    if (estimator === "parkinson") {
      rangeSum += range * range / (4 * Math.LN2);
    } else if (estimator === "garman-klass") {
      const intraday = close - point.open!;
      rangeSum += 0.5 * range * range - (2 * Math.LN2 - 1) * intraday * intraday;
    } else {
      const open = point.open!;
      rangeSum += (high - open) * (high - close) + (low - open) * (low - close);
      if (estimator === "yang-zhang") {
        returns.push(close - open);
        overnightReturns.push(open - history[index - 1]!.close!);
      }
    }
  }

  let variance: number;
  if (estimator === "close-to-close") {
    variance = sampleVariance(returns);
  } else if (estimator === "yang-zhang") {
    const weight = 0.34 / (1.34 + (window + 1) / (window - 1));
    variance = sampleVariance(overnightReturns) + weight * sampleVariance(returns) + (1 - weight) * rangeSum / window;
  } else {
    variance = rangeSum / window;
  }
  if (!Number.isFinite(variance) || variance < -64 * Number.EPSILON) return unavailable("invalid-variance");
  // Integrity checks permit machine precision noise at an OHLC boundary.
  return { value: Math.sqrt(Math.max(0, variance) * VOLATILITY_TRADING_DAYS) };
}

/**
 * Latest n-session estimate. Close-to-close and Yang-Zhang need n+1 observations;
 * range estimators need n. Holidays and missing sessions cannot be inferred without
 * an exchange calendar. Supplied invalid observations remain gaps, never bridges.
 */
export function realizedVolatilityResult(
  points: readonly PricePoint[],
  window = 30,
  estimator: RealizedVolatilityEstimator = "close-to-close",
): RealizedVolatilityResult {
  if (!validWindow(window)) return unavailable("invalid-window");
  const history = observations(points);
  return history === null ? unavailable("invalid-date") : estimateWindow(history, history.length - 1, window, estimator);
}

export function realizedVolatility(
  points: readonly PricePoint[],
  window = 30,
  estimator: RealizedVolatilityEstimator = "close-to-close",
): number | null {
  return realizedVolatilityResult(points, window, estimator).value;
}

/** Invalid dates make chronology unknowable and return no series. */
export function rollingRealizedVolatility(
  points: readonly PricePoint[],
  options: RollingRealizedVolatilityOptions = {},
): RollingRealizedVolatilityPoint[] {
  const history = observations(points);
  if (history === null) return [];
  const windows = [...new Set(options.windows ?? REALIZED_VOLATILITY_WINDOWS)];
  const estimator = options.estimator ?? "close-to-close";
  return history.map((point, index) => ({
    date: new Date(point.time),
    values: Object.fromEntries(windows.map((window) => [window, estimateWindow(history, index, window, estimator).value])),
  }));
}

/** Rolling estimates end inside the calendar lookback; earlier bars supply warmup. */
export function volatilityCone(
  points: readonly PricePoint[],
  options: VolatilityConeOptions = {},
): VolatilityConeStatistics[] {
  const windows = [...new Set(options.windows ?? REALIZED_VOLATILITY_WINDOWS)];
  const series = rollingRealizedVolatility(points, { ...options, windows });
  const latest = series.at(-1);
  const cutoff = new Date(latest?.date ?? 0);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - (options.lookbackYears ?? 1));
  // February 29 maps to February 28 when the prior year is not a leap year.
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  const selected = series.filter((point) => point.date.getTime() > cutoff.getTime());
  return windows.map((window) => {
    const current = latest?.values[window] ?? null;
    const values = selected.flatMap((point) => {
      const value = point.values[window];
      return value == null ? [] : [value];
    }).sort((a, b) => a - b);
    const sampleSize = values.length;
    const midpoint = Math.floor(sampleSize / 2);
    return {
      window,
      current,
      min: values[0] ?? null,
      max: values.at(-1) ?? null,
      mean: sampleSize > 0 ? values.reduce((total, value) => total + value, 0) / sampleSize : null,
      median: sampleSize > 0 ? (sampleSize % 2 ? values[midpoint]! : (values[midpoint - 1]! + values[midpoint]!) / 2) : null,
      percentile: current !== null && sampleSize > 0
        ? 100 * (values.filter((value) => value < current).length + 0.5 * values.filter((value) => value === current).length) / sampleSize
        : null,
      sampleSize,
    };
  });
}
