import { barsPerYear, type BarsPerYear } from "../../../market-data/bars-per-year";
import type { PricePoint } from "../../../types/financials";
import {
  REALIZED_VOLATILITY_WINDOWS, realizedVolatilityCadenceIssue, realizedVolatilityResult, rollingRealizedVolatility, volatilityCone,
  type RealizedVolatilityEstimator, type RollingRealizedVolatilityPoint, type VolatilityConeStatistics,
} from "../shared/volatility";
import type { SurfaceExpiry, SurfaceSnapshot } from "../vol-surface/model";

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
  /** What the volatility is annualised at, read from the series' own dates. */
  barsPerYear: BarsPerYear;
  warnings: string[];
  /**
   * The windows the history is too short for, longest last: a stock that
   * listed in May has no 180- or 260-bar estimate yet, and nothing failed.
   */
  shortWindows: number[];
  /**
   * What a short history leaves out, said once: "History starts 2026-05-07: 121
   * daily bars so far; the 180- and 260-bar windows need more". Null when the
   * history covers the lookback and every window.
   */
  historyNote: string | null;
}

/** "the 180-bar window", "the 180- and 260-bar windows", "the 90-, 180- and 260-bar windows". */
function windowsText(windows: readonly number[]): string {
  if (windows.length === 1) return `the ${windows[0]}-bar window`;
  const head = windows.slice(0, -1).map((window) => `${window}-`);
  return `the ${head.join(", ")} and ${windows.at(-1)}-bar windows`;
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
  // What follows from a history shorter than the windows and lookback asked for: notes, not failures.
  let shortLookback = false;
  let shortWarmup = false;
  const shortWindows: number[] = [];
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
  if (history.length > 0 && history[0]!.date.getTime() > cutoff) shortLookback = true;
  for (const window of history.length > 0 && !cadenceIssue ? REALIZED_VOLATILITY_WINDOWS : []) {
    const result = realizedVolatilityResult(history, window, estimator);
    if (result.reason === "insufficient-history") shortWindows.push(window);
    else if (result.reason) warnings.push(`HV${window} unavailable: ${result.reason.replaceAll("-", " ")}`);
  }
  const priorWarmup = history.filter((point) => point.date.getTime() <= cutoff).length;
  const requiredWarmup = estimator === "close-to-close" || estimator === "yang-zhang" ? 260 : 259;
  if (history.length > 0 && !cadenceIssue && priorWarmup < requiredWarmup) {
    shortWarmup = true;
  } else if (!cadenceIssue && cone.some((row) => row.sampleSize < visible.length)) {
    warnings.push("Unavailable historical estimates reduce volatility-cone sample coverage");
  }
  const first = history[0]?.date.toISOString().slice(0, 10);
  // Where the history starts, never read as the listing date: a source's first bar is not proof of when it listed.
  const historyNote = !first || (!shortLookback && !shortWarmup && !shortWindows.length) ? null
    : `History starts ${first}: ${history.length} daily bars so far; ${shortWindows.length
      ? `${windowsText(shortWindows)} need${shortWindows.length === 1 ? "s" : ""} more`
      : "the long windows' cone covers part of the lookback"}`;
  return { symbol: options.symbol.trim().toUpperCase(), estimator, lookbackYears, windows,
    history: visible, series: visibleSeries, cone, asOf, barsPerYear: barsPerYear(history.map((point) => point.date)),
    warnings: [...new Set(warnings)], shortWindows, historyNote };
}

interface CurrentAtmIvReference {
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
  /** The underlying has no option chain in the sources, so there is no IV to show and nothing failed. */
  noOptionChain?: boolean;
}

/** When an IV was observed, to the minute in UTC (`2026-10-27 20:14 UTC`), in the pane and the report alike. */
export function atmIvObservedLabel(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A LEAPS ATM IV is not comparable with a 10 to 260 session realized cone. */
const MAX_CURRENT_ATM_IV_DAYS = 90;

/**
 * Use a listed expiry nearest 30 days, preserving its own observation date and tenor. Warnings and
 * failures are the chosen slice's and the surface's own, not those of expiries the reference does not use.
 */
export function projectCurrentAtmIv(surface: SurfaceSnapshot): CurrentAtmIvSnapshot {
  if (surface.catalogue.length === 0 && surface.failures.some((failure) => failure.expiration == null && failure.reasonCode === "NO_DATA")) {
    return { reference: null, error: null, warnings: [], noOptionChain: true };
  }
  const eligible = surface.expiries.filter((expiry) => expiry.years > 0 && expiry.years * 365 <= MAX_CURRENT_ATM_IV_DAYS);
  const usable = (expiry: SurfaceExpiry) => expiry.atmIV != null && Number.isFinite(expiry.atmIV) && expiry.atmIV > 0;
  const distance = (expiry: SurfaceExpiry) => Math.abs(expiry.years * 365 - 30);
  const warnings: string[] = [];
  const candidates = eligible.filter(usable);
  const fresh = candidates.filter((expiry) => !expiry.stale && !expiry.error);
  if (fresh.length < candidates.length) warnings.push("Stale or failed ATM IV slices excluded from the current reference");
  const dated = fresh.filter((expiry) => expiry.asOf != null && Number.isFinite(Date.parse(expiry.asOf)));
  if (dated.length < fresh.length) warnings.push("Some ATM IV observations have no valid source date");
  dated.sort((a, b) => distance(a) - distance(b) || a.expiration - b.expiration);
  const expiry = dated[0];
  if (!expiry) {
    const errors = [...new Set(surface.failures.map((failure) => failure.message))];
    return { reference: null, error: errors.join("; ") || "Current ATM IV unavailable from cleaned option quotes",
      warnings: [...new Set([...eligible.flatMap((entry) => entry.warnings), ...warnings])] };
  }
  const daysToExpiry = expiry.years * 365;
  if (eligible.some((entry) => !usable(entry) && distance(entry) < distance(expiry))) {
    warnings.push(`Expiries nearer 30 days have no usable ATM quotes; reference uses the ${Math.round(daysToExpiry)}d expiry`);
  }
  if (surface.spotAsOf == null) warnings.push("Underlying quote observation date unavailable");
  const errors = [...new Set(surface.failures.filter((failure) => failure.expiration == null).map((failure) => failure.message))];
  return { reference: {
    value: expiry.atmIV!, date: new Date(expiry.asOf!),
    label: `ATM IV ${Math.round(daysToExpiry)}d`,
    daysToExpiry, expiration: expiry.expiration, source: expiry.source, stale: expiry.stale,
    ivSource: surface.settings.ivSource, spot: surface.spot, spotAsOf: surface.spotAsOf ?? null,
  }, error: errors.join("; ") || null, warnings: [...new Set([...expiry.warnings, ...warnings])] };
}
