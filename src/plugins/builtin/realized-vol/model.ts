import type { PricePoint } from "../../../types/financials";
import {
  REALIZED_VOLATILITY_WINDOWS, realizedVolatilityCadenceIssue, realizedVolatilityResult, rollingRealizedVolatility, volatilityCone,
  type RealizedVolatilityEstimator, type RollingRealizedVolatilityPoint, type VolatilityConeStatistics,
} from "../shared/volatility";
import type { SurfaceSnapshot } from "../vol-surface/model";

export interface RealizedVolatilityModel {
  symbol: string;
  estimator: RealizedVolatilityEstimator;
  lookbackYears: 1 | 2;
  windows: number[];
  history: PricePoint[];
  series: RollingRealizedVolatilityPoint[];
  /** The cone always includes all seven standard windows, independent of chart selection. */
  cone: VolatilityConeStatistics[];
  asOf: Date | null;
  warnings: string[];
}

export interface RealizedVolatilityProjectionOptions {
  symbol: string;
  estimator?: RealizedVolatilityEstimator;
  lookbackYears?: 1 | 2;
  windows?: readonly number[];
}

function lookbackCutoff(date: Date, years: number): number {
  const cutoff = new Date(date);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return cutoff.getTime();
}

/** Calculate from the complete daily buffer before clipping the visible calendar lookback. */
export function projectRealizedVolatility(
  points: readonly PricePoint[], options: RealizedVolatilityProjectionOptions,
): RealizedVolatilityModel {
  const estimator = options.estimator ?? "close-to-close";
  const lookbackYears = options.lookbackYears === 2 ? 2 : 1;
  const windows = [...new Set(options.windows ?? REALIZED_VOLATILITY_WINDOWS)]
    .filter((window) => REALIZED_VOLATILITY_WINDOWS.some((standard) => standard === window));
  const warnings: string[] = [];
  const dates = new Map<number, PricePoint>();
  for (const point of points) {
    const date = new Date(point.date);
    if (!Number.isFinite(date.getTime())) {
      warnings.push("Realized volatility unavailable: invalid history date");
      dates.clear();
      break;
    }
    dates.set(date.getTime(), { ...point, date });
  }
  const history = [...dates.entries()].sort(([a], [b]) => a - b).map(([, point]) => point);
  const asOf = history.at(-1)?.date ?? null;
  const cutoff = asOf ? lookbackCutoff(asOf, lookbackYears) : 0;
  const cadenceIssue = realizedVolatilityCadenceIssue(history);
  if (cadenceIssue) warnings.push(cadenceIssue);
  const series = cadenceIssue
    ? history.map((point) => ({ date: point.date, values: Object.fromEntries(windows.map((window) => [window, null])) }))
    : rollingRealizedVolatility(history, { windows, estimator });
  const cone = volatilityCone(cadenceIssue ? [] : history, { estimator, lookbackYears });
  const visible = history.filter((point) => point.date.getTime() > cutoff);
  const visibleSeries = series.filter((point) => point.date.getTime() > cutoff);
  if (history.length > 0 && history[0]!.date.getTime() > cutoff) {
    warnings.push(`History covers less than the requested ${lookbackYears}Y lookback`);
  }
  for (const window of history.length > 0 && !cadenceIssue ? REALIZED_VOLATILITY_WINDOWS : []) {
    const result = realizedVolatilityResult(history, window, estimator);
    if (result.reason === "insufficient-history") warnings.push(`HV${window} needs more daily history`);
    else if (result.reason) warnings.push(`HV${window} unavailable: ${result.reason.replaceAll("-", " ")}`);
  }
  const priorWarmup = history.filter((point) => point.date.getTime() <= cutoff).length;
  const requiredWarmup = estimator === "close-to-close" || estimator === "yang-zhang" ? 260 : 259;
  if (history.length > 0 && !cadenceIssue && priorWarmup < requiredWarmup) {
    warnings.push("Long-window cone estimates do not cover the complete lookback");
  } else if (!cadenceIssue && cone.some((row) => row.sampleSize < visible.length)) {
    warnings.push("Unavailable historical estimates reduce volatility-cone sample coverage");
  }
  return { symbol: options.symbol.trim().toUpperCase(), estimator, lookbackYears, windows,
    history: visible, series: visibleSeries, cone, asOf, warnings: [...new Set(warnings)] };
}

export interface CurrentAtmIvReference {
  value: number;
  date: Date;
  label: string;
  daysToExpiry: number;
  expiration: number;
  source: string | null;
  stale: boolean;
  ivSource: "provider" | "recomputed";
  spot: number;
  spotAsOf: string | number | null;
}

export interface CurrentAtmIvSnapshot {
  reference: CurrentAtmIvReference | null;
  error: string | null;
  warnings: string[];
}

/** A LEAPS ATM IV is not comparable with a 10 to 260 session realized cone. */
export const MAX_CURRENT_ATM_IV_DAYS = 90;

/** Use a listed expiry nearest 30 days, preserving its own observation date and tenor. */
export function projectCurrentAtmIv(surface: SurfaceSnapshot): CurrentAtmIvSnapshot {
  const warnings = [...surface.warnings];
  const candidates = surface.expiries.filter((expiry) => expiry.atmIV != null
    && Number.isFinite(expiry.atmIV) && expiry.atmIV > 0 && expiry.years > 0 && expiry.years * 365 <= MAX_CURRENT_ATM_IV_DAYS);
  const fresh = candidates.filter((expiry) => !expiry.stale && !expiry.error);
  if (fresh.length < candidates.length) warnings.push("Stale or failed ATM IV slices excluded from the current reference");
  const dated = fresh.filter((expiry) => expiry.asOf != null && Number.isFinite(Date.parse(expiry.asOf)));
  if (dated.length < fresh.length) warnings.push("Some ATM IV observations have no valid source date");
  dated.sort((a, b) => Math.abs(a.years * 365 - 30) - Math.abs(b.years * 365 - 30) || a.expiration - b.expiration);
  const expiry = dated[0];
  const errors = [...new Set(surface.failures.map((failure) => failure.message))];
  if (!expiry) {
    return { reference: null, error: errors.join("; ") || "Current ATM IV unavailable from cleaned option quotes", warnings };
  }
  const daysToExpiry = expiry.years * 365;
  if (surface.spotAsOf == null) warnings.push("Underlying quote observation date unavailable");
  return { reference: {
    value: expiry.atmIV!, date: new Date(expiry.asOf!),
    label: `ATM IV ${Math.round(daysToExpiry)}d (${surface.settings.ivSource})`,
    daysToExpiry, expiration: expiry.expiration, source: expiry.source, stale: expiry.stale,
    ivSource: surface.settings.ivSource, spot: surface.spot, spotAsOf: surface.spotAsOf ?? null,
  }, error: errors.join("; ") || null, warnings: [...new Set(warnings)] };
}
