import type { OptionContract, OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, daysToExpiryFrom, solveImpliedVolatility, valueOption, type OptionSide } from "../options-calculator/model";
import {
  detectButterflyArbitrage, detectCalendarArbitrage, evaluateSmile, expectedMove,
  extractImpliedForward, fitVolatilitySmile, FIXED_VOLATILITY_TENORS,
  interpolateTotalVariance, logForwardMoneyness, optionDelta, optionMid,
  smileSkew, volatilityTermSlope,
  type ExpectedMove, type ImpliedForward, type SkewMetrics, type SmileFit,
} from "../shared/volatility";
import type { YieldPoint } from "../yield-curve/treasury-data";

export interface SurfaceSettings {
  ivSource: "recomputed" | "provider";
  priceSide: "mid" | "bid" | "ask";
  maxRelativeSpread: number;
  maxStaleSessions: number;
}

export const DEFAULT_SURFACE_SETTINGS: SurfaceSettings = {
  ivSource: "recomputed", priceSide: "mid", maxRelativeSpread: 0.5, maxStaleSessions: 5,
};
export const SURFACE_MONEYNESS = [0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2] as const;
export const SURFACE_DELTAS = [-0.1, -0.25, 0, 0.25, 0.1] as const;
/** 3D delta axis: 10-delta put through ATM (spot strike) to 10-delta call, in 5-delta steps. */
/** The 3D sheet's constant maturities, as on a dealer surface. */
export const SURFACE_3D_TENORS = [
  { label: "1W", years: 7 / 365 }, { label: "2W", years: 14 / 365 }, { label: "1M", years: 30 / 365 },
  { label: "2M", years: 61 / 365 }, { label: "3M", years: 91 / 365 }, { label: "4M", years: 122 / 365 },
  { label: "6M", years: 182 / 365 }, { label: "9M", years: 273 / 365 }, { label: "1Y", years: 1 },
  { label: "18M", years: 1.5 }, { label: "2Y", years: 2 }, { label: "3Y", years: 3 },
] as const;

/**
 * The constant maturities a snapshot can support without extrapolation: at
 * least four, inside the first and last expiries with a fitted smile.
 */
export function surfaceSheetTenors(snapshot: SurfaceSnapshot): ReadonlyArray<{ label: string; years: number }> | null {
  const years = snapshot.expiries.filter((entry) => entry.fit && entry.forward != null).map((entry) => entry.years);
  if (!years.length) return null;
  const first = Math.min(...years), last = Math.max(...years);
  const inside = SURFACE_3D_TENORS.filter((tenor) => tenor.years >= first - 1e-9 && tenor.years <= last + 1e-9);
  return inside.length >= 4 ? inside : null;
}

export const SURFACE_3D_DELTAS = [-0.1, -0.15, -0.2, -0.25, -0.3, -0.35, -0.4, -0.45, 0, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1] as const;

export type SurfaceFilterReason = "invalid-contract" | "expiry-mismatch" | "zero-bid" | "crossed"
  | "wide-spread" | "no-interest" | "stale-duplicate" | "duplicate" | "itm" | "iv-unavailable";
export type SurfaceFilterCounts = Record<SurfaceFilterReason, number>;

export interface SurfacePoint {
  contract: OptionContract;
  side: OptionSide;
  strike: number;
  moneyness: number;
  logMoneyness: number;
  mid: number;
  price: number;
  spread: number;
  spreadRatio: number;
  openInterest: number;
  providerIV: number | null;
  volatility: number;
  fitResidual: number | null;
}

export interface SurfaceExpiry {
  expiration: number;
  years: number;
  state: "loading" | "ready" | "empty" | "error";
  asOf: string | null;
  source: string | null;
  dataSource: "live" | "delayed" | null;
  feed: OptionsChain["feed"] | null;
  realtimeEligible: boolean | null;
  delayMinutes: number | null;
  stale: boolean;
  rate: number | null;
  rateMethod: "treasury-exact" | "treasury-interpolated" | "treasury-boundary" | "unavailable";
  rateAsOf: string[];
  forward: number | null;
  dividendYield: number | null;
  parity: ImpliedForward;
  points: SurfacePoint[];
  fit: SmileFit | null;
  atmIV: number | null;
  expectedMove: ExpectedMove;
  skew: SkewMetrics;
  filterCounts: SurfaceFilterCounts;
  warnings: string[];
  error: string | null;
  termSlope: number | null;
}

export interface SurfaceFailure { expiration: number | null; message: string }

export interface SurfaceSnapshot {
  symbol: string;
  spot: number;
  spotAsOf?: string | number | null;
  phase: "loading" | "partial" | "ready" | "error";
  settings: SurfaceSettings;
  catalogue: number[];
  requested: number;
  loaded: number;
  failed: number;
  expiries: SurfaceExpiry[];
  failures: SurfaceFailure[];
  warnings: string[];
  rateAsOf: string | null;
  fetchedAt: number;
}

const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const emptyParity = (): ImpliedForward => ({ forward: null, dividendYield: null, pairs: [], method: "unavailable", warnings: [] });
const emptySkew = (): SkewMetrics => ({ put25: null, call25: null, atm: null, putCallSkew: null, riskReversal: null, butterfly: null, moneynessSkew: null });
const emptyCounts = (): SurfaceFilterCounts => ({ "invalid-contract": 0, "expiry-mismatch": 0, "zero-bid": 0, crossed: 0,
  "wide-spread": 0, "no-interest": 0, "stale-duplicate": 0, duplicate: 0, itm: 0, "iv-unavailable": 0 });

export function normalizeSurfaceSettings(settings: Partial<SurfaceSettings> = {}): SurfaceSettings {
  return {
    ivSource: settings.ivSource === "provider" ? "provider" : "recomputed",
    priceSide: settings.priceSide === "bid" || settings.priceSide === "ask" ? settings.priceSide : "mid",
    maxRelativeSpread: Number.isFinite(settings.maxRelativeSpread) && settings.maxRelativeSpread! >= 0
      ? settings.maxRelativeSpread! : DEFAULT_SURFACE_SETTINGS.maxRelativeSpread,
    maxStaleSessions: Number.isFinite(settings.maxStaleSessions) && settings.maxStaleSessions! >= 0
      ? Math.floor(settings.maxStaleSessions!) : DEFAULT_SURFACE_SETTINGS.maxStaleSessions,
  };
}

export interface SurfaceRate {
  rate: number | null;
  method: SurfaceExpiry["rateMethod"];
  asOf: string[];
  warnings: string[];
}

/** Treasury yields are percent. Linear tenor interpolation uses decimal yields in the pricer. */
export function surfaceTreasuryRate(curve: readonly YieldPoint[], years: number): SurfaceRate {
  const missing = (): SurfaceRate => ({ rate: null, method: "unavailable", asOf: [], warnings: ["Treasury rate unavailable"] });
  if (!positive(years)) return missing();
  const points = curve.filter((point) => positive(point.maturityYears) && point.yield != null && Number.isFinite(point.yield))
    .slice().sort((a, b) => a.maturityYears - b.maturityYears);
  if (!points.length) return missing();
  const exact = points.find((point) => point.maturityYears === years);
  const rightIndex = points.findIndex((point) => point.maturityYears > years);
  const left = exact ?? (rightIndex < 0 ? points.at(-1)! : points[Math.max(0, rightIndex - 1)]!);
  const right = exact ?? (rightIndex < 0 ? left : points[rightIndex]!);
  const weight = left === right ? 0 : (years - left.maturityYears) / (right.maturityYears - left.maturityYears);
  const rate = (left.yield! + weight * (right.yield! - left.yield!)) / 100;
  if (!Number.isFinite(rate)) return missing();
  const asOf = [...new Set([left.asOf, right.asOf].filter((date): date is string => typeof date === "string" && Number.isFinite(Date.parse(date))))];
  const method = exact ? "treasury-exact" : left === right ? "treasury-boundary" : "treasury-interpolated";
  const warnings: string[] = [];
  if (method === "treasury-boundary") warnings.push(`Treasury ${left.maturity} rate held outside the published tenor range`);
  if (asOf.length === 0) warnings.push("Treasury observation date unavailable");
  if (asOf.length > 1) warnings.push("Treasury interpolation uses different source dates");
  if (left.stale || right.stale) warnings.push("Treasury source is stale");
  return { rate, method, asOf, warnings };
}

/** Weekdays are a session proxy; exchange holidays are not inferred from option trade timestamps. */
function weekdaysBetween(earlierSeconds: number, laterMs: number): number {
  const first = Math.floor(earlierSeconds / 86400);
  const last = Math.floor(laterMs / 86400000);
  const days = Math.max(0, last - first);
  const weeks = Math.floor(days / 7);
  let sessions = weeks * 5;
  for (let day = first + weeks * 7 + 1; day <= last; day += 1) {
    const weekday = new Date(day * 86400000).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions += 1;
  }
  return sessions;
}

export interface CleanSurfaceQuotes {
  calls: OptionContract[];
  puts: OptionContract[];
  filterCounts: SurfaceFilterCounts;
}

/** Cleaning applies equally to provider IV and recomputed IV. Last trades never replace quotes. */
export function cleanSurfaceQuotes(chain: OptionsChain, expiration: number, settings: SurfaceSettings, now: number): CleanSurfaceQuotes {
  const filterCounts = emptyCounts();
  const clean = (contracts: readonly OptionContract[]) => {
    const freshest = new Map<number, number>();
    for (const contract of contracts) {
      if (contract.expiration === expiration && positive(contract.strike) && positive(contract.lastTradeDate)) {
        freshest.set(contract.strike, Math.max(freshest.get(contract.strike) ?? 0, contract.lastTradeDate));
      }
    }
    const selected = new Map<number, OptionContract>();
    for (const contract of contracts) {
      let reason: SurfaceFilterReason | null = null;
      if (!positive(contract.strike) || !positive(contract.expiration)) reason = "invalid-contract";
      else if (contract.expiration !== expiration) reason = "expiry-mismatch";
      else if (!positive(contract.bid) || !positive(contract.ask)) reason = "zero-bid";
      else if (contract.ask < contract.bid) reason = "crossed";
      else if ((contract.ask - contract.bid) / optionMid(contract)! > settings.maxRelativeSpread + 1e-12) reason = "wide-spread";
      else if (!positive(contract.openInterest)) reason = "no-interest";
      else if ((freshest.get(contract.strike) ?? 0) > (contract.lastTradeDate || 0)
        && (!positive(contract.lastTradeDate) || weekdaysBetween(contract.lastTradeDate, now) > settings.maxStaleSessions)) reason = "stale-duplicate";
      if (reason) { filterCounts[reason] += 1; continue; }
      const previous = selected.get(contract.strike);
      if (previous) {
        filterCounts.duplicate += 1;
        const freshness = (contract.lastUpdated ?? contract.lastTradeDate * 1000) - (previous.lastUpdated ?? previous.lastTradeDate * 1000);
        if (freshness < 0 || (freshness === 0 && contract.ask - contract.bid >= previous.ask - previous.bid)) continue;
      }
      selected.set(contract.strike, contract);
    }
    return [...selected.values()].sort((a, b) => a.strike - b.strike);
  };
  return { calls: clean(chain.calls), puts: clean(chain.puts), filterCounts };
}

export function pendingSurfaceExpiry(expiration: number, now: number): SurfaceExpiry {
  return { expiration, years: daysToExpiryFrom(expiration, now) / 365, state: "loading", asOf: null, source: null,
    dataSource: null, feed: null, realtimeEligible: null, delayMinutes: null, stale: false, rate: null, rateMethod: "unavailable", rateAsOf: [],
    forward: null, dividendYield: null, parity: emptyParity(), points: [], fit: null, atmIV: null,
    expectedMove: { straddle: null, straddlePercent: null, sigma: null, sigmaPercent: null, strike: null },
    skew: emptySkew(), filterCounts: emptyCounts(), warnings: [], error: null, termSlope: null };
}

export interface BuildSurfaceExpiryInput {
  chain: OptionsChain;
  expiration: number;
  spot: number;
  curve: readonly YieldPoint[];
  settings?: Partial<SurfaceSettings>;
  now: number;
  source?: string | null;
  stale?: boolean;
  error?: string | null;
}

const CLOSED_QUOTE_GAP_MS = 60 * 60_000;

/**
 * Quotes carry the time value of the moment they were observed. A closed
 * session's final NBBO read against today's clock would shorten every
 * expiry by the overnight gap and inflate the front-month IVs. A delayed
 * feed's quarter hour is immaterial, so only a gap over an hour moves it.
 */
export function optionQuoteValuationTime(chain: Pick<OptionsChain, "asOf">, now: number): number {
  const observedAt = chain.asOf ? Date.parse(chain.asOf) : Number.NaN;
  return Number.isFinite(observedAt) && observedAt < now - CLOSED_QUOTE_GAP_MS ? observedAt : now;
}
/**
 * Listed strikes the cleaned smile may skip around the forward. A coarse
 * chain skips one; a chain whose near-the-money quotes are all zero-bid
 * (Yahoo after the close, on LEAPS) skips dozens, and a fit bridging the
 * wings then invents the ATM level.
 */
const MAX_UNQUOTED_FORWARD_STRIKES = 8;

function unquotedStrikesAroundForward(chain: OptionsChain, expiration: number, points: readonly SurfacePoint[], forward: number): number {
  let below = -Infinity, above = Infinity;
  for (const point of points) {
    if (point.strike < forward) below = Math.max(below, point.strike);
    else above = Math.min(above, point.strike);
  }
  if (!Number.isFinite(below) || !Number.isFinite(above)) return 0;
  const listed = new Set([...chain.calls, ...chain.puts]
    .filter((contract) => contract.expiration === expiration && contract.strike > below && contract.strike < above)
    .map((contract) => contract.strike));
  return listed.size;
}

/**
 * The expiries the 3D sheet draws. An expiry whose SVI fit failed falls back
 * to exact interpolation through its quotes; at the edge of the tenor range
 * nothing smooths it, and its quote noise reads as a spike in the sheet. With
 * at least four SVI slices, the sheet uses those only. Tables keep every expiry.
 */
export function surfaceSheetSnapshot<T extends SurfaceSnapshot>(snapshot: T): { snapshot: T; omitted: SurfaceExpiry[] } {
  const fitted = snapshot.expiries.filter((entry) => entry.fit?.method === "svi");
  if (fitted.length < 4 || fitted.length === snapshot.expiries.length) return { snapshot, omitted: [] };
  return { snapshot: { ...snapshot, expiries: fitted }, omitted: snapshot.expiries.filter((entry) => entry.fit && entry.fit.method !== "svi") };
}

export function buildSurfaceExpiry(input: BuildSurfaceExpiryInput): SurfaceExpiry {
  const { chain, expiration, spot, curve, now } = input;
  const settings = normalizeSurfaceSettings(input.settings);
  const valuationTime = optionQuoteValuationTime(chain, now);
  const result = pendingSurfaceExpiry(expiration, valuationTime);
  result.state = "empty";
  result.source = chain.providerId ?? input.source ?? null;
  result.asOf = chain.asOf ?? null;
  result.dataSource = chain.dataSource ?? null;
  result.feed = chain.feed ?? null;
  result.realtimeEligible = chain.realtimeEligible ?? null;
  result.delayMinutes = chain.delayMinutes ?? null;
  result.stale = input.stale ?? false;
  result.error = input.error ?? null;
  const rate = surfaceTreasuryRate(curve, result.years);
  result.rate = rate.rate;
  result.rateMethod = rate.method;
  result.rateAsOf = rate.asOf;
  result.warnings.push(...rate.warnings);
  if (!positive(spot)) { result.error = "Underlying quote unavailable"; return result; }
  if (!(result.years > 0)) { result.error = "Expiration has no remaining time value"; return result; }
  const cleaned = cleanSurfaceQuotes(chain, expiration, settings, now);
  result.filterCounts = cleaned.filterCounts;
  // The quoted straddle needs no rate or parity estimate. Preserve it in partial models.
  result.expectedMove = expectedMove(cleaned.calls, cleaned.puts, spot, result.years, null);
  if (rate.rate === null) return result;
  result.parity = extractImpliedForward(cleaned.calls, cleaned.puts, spot, result.years, rate.rate, chain.underlyingSymbol);
  result.forward = result.parity.forward;
  result.dividendYield = result.parity.dividendYield;
  result.warnings.push(...result.parity.warnings);
  if (result.forward === null || result.dividendYield === null) return result;
  const forward = result.forward;
  for (const [side, contracts] of [["put", cleaned.puts], ["call", cleaned.calls]] as const) {
    for (const contract of contracts) {
      if (side === "put" ? contract.strike >= forward : contract.strike < forward) { result.filterCounts.itm += 1; continue; }
      const mid = optionMid(contract)!;
      const price = settings.priceSide === "mid" ? mid : contract[settings.priceSide];
      const providerIV = positive(contract.impliedVolatility) ? contract.impliedVolatility : null;
      // q=r turns the shared spot pricer into discounted forward pricing.
      const solved = settings.ivSource === "provider" ? providerIV : solveImpliedVolatility({
        ...DEFAULT_OPTION_CALC_DRAFT, side, spot: forward, strike: contract.strike,
        daysToExpiry: result.years * 365, rate: rate.rate, dividendYield: rate.rate,
      }, price).volatility;
      if (!positive(solved)) { result.filterCounts["iv-unavailable"] += 1; continue; }
      result.points.push({ contract, side, strike: contract.strike, moneyness: contract.strike / spot,
        logMoneyness: logForwardMoneyness(contract.strike, forward)!, mid, price,
        spread: contract.ask - contract.bid, spreadRatio: (contract.ask - contract.bid) / mid,
        openInterest: contract.openInterest!, providerIV, volatility: solved, fitResidual: null });
    }
  }
  result.points.sort((a, b) => a.strike - b.strike);
  if (unquotedStrikesAroundForward(chain, expiration, result.points, forward) > MAX_UNQUOTED_FORWARD_STRIKES) {
    result.warnings.push("No usable quotes near the forward");
    return result;
  }
  result.fit = fitVolatilitySmile(result.points, result.years);
  if (!result.fit) {
    result.warnings.push("Fewer than two cleaned OTM strikes are available");
    return result;
  }
  const fit = result.fit;
  const smile = (strike: number) => evaluateSurfaceSmile(result, strike);
  for (const point of result.points) point.fitResidual = point.volatility - (smile(point.strike) ?? point.volatility);
  result.atmIV = smile(spot);
  const skew = smileSkew({ spot, years: result.years, rate: rate.rate, dividendYield: result.dividendYield },
    (strike) => evaluateSmile(fit, logForwardMoneyness(strike, forward)!));
  const putCovered = deltaStrike(result, spot, -0.25) != null;
  const callCovered = deltaStrike(result, spot, 0.25) != null;
  const moneynessCovered = smile(spot * 0.9) != null && smile(spot * 1.1) != null;
  result.skew = { ...skew, atm: result.atmIV, put25: putCovered ? skew.put25 : null, call25: callCovered ? skew.call25 : null,
    putCallSkew: putCovered && callCovered ? skew.putCallSkew : null,
    riskReversal: putCovered && callCovered ? skew.riskReversal : null,
    butterfly: putCovered && callCovered && result.atmIV != null ? skew.butterfly : null,
    moneynessSkew: moneynessCovered ? skew.moneynessSkew : null };
  result.expectedMove = expectedMove(cleaned.calls, cleaned.puts, spot, result.years, result.atmIV);
  const calls = result.points.map((point) => ({ strike: point.strike, callPrice: valueOption({
    ...DEFAULT_OPTION_CALC_DRAFT, side: "call", spot: forward, strike: point.strike,
    daysToExpiry: result.years * 365, rate: rate.rate!, dividendYield: rate.rate!, volatility: smile(point.strike)!,
  }).price }));
  const butterfly = detectButterflyArbitrage(calls);
  if (butterfly.length) result.warnings.push(`${butterfly.length} butterfly arbitrage ${butterfly.length === 1 ? "warning" : "warnings"}`);
  if (fit.fallbackReason) result.warnings.push(fit.fallbackReason);
  result.state = "ready";
  return result;
}

export function surfaceCalendarWarnings(expiries: readonly SurfaceExpiry[]): string[] {
  let count = 0;
  for (const ratio of SURFACE_MONEYNESS) {
    const points = expiries.flatMap((expiry) => {
      const volatility = expiry.forward == null ? null : evaluateSurfaceSmile(expiry, expiry.forward * ratio);
      return volatility == null ? [] : [{ years: expiry.years, volatility }];
    });
    count += detectCalendarArbitrage(points).length;
  }
  return count > 0 ? [`${count} calendar arbitrage ${count === 1 ? "warning" : "warnings"}`] : [];
}

export function withSurfaceTermSlopes(expiries: readonly SurfaceExpiry[]): SurfaceExpiry[] {
  const sorted = [...expiries].sort((a, b) => a.years - b.years);
  return sorted.map((expiry, index) => {
    const next = sorted.slice(index + 1).find((item) => item.atmIV != null);
    return { ...expiry, termSlope: expiry.atmIV != null && next?.atmIV != null
      ? volatilityTermSlope({ years: expiry.years, volatility: expiry.atmIV }, { years: next.years, volatility: next.atmIV }) : null };
  });
}

export interface SurfaceGridOptions {
  axis?: "spot" | "forward" | "delta" | "strike";
  tenors?: "listed" | "fixed";
  coordinates?: readonly number[];
  /** Constant maturities for `tenors: "fixed"`; defaults to 1W through 1Y. */
  fixedTenors?: ReadonlyArray<{ label: string; years: number }>;
}

export interface SurfaceCell {
  coordinate: number;
  strike: number | null;
  volatility: number | null;
  point: SurfacePoint | null;
  fitResidual: number | null;
}

export type SurfaceGridCell = SurfaceCell;

export interface SurfaceGridRow {
  expiration: number | null;
  years: number;
  rate: number | null;
  dividendYield: number | null;
  forward: number | null;
  label: string;
  interpolated: boolean;
  extrapolated: boolean;
  cells: SurfaceCell[];
}

export interface SurfaceGrid {
  rows: SurfaceGridRow[];
  tenors: number[];
  /** Axis coordinates. For the raster use the spot or forward ratio axis. */
  moneyness: number[];
  volatilities: (number | null)[][];
}

/** Default 3D window: strikes within this many ATM standard deviations of the forward. */
export const SURFACE_SIGMA_WINDOW = 2.5;

/**
 * Restrict each listed expiry to strikes within `sigmas` ATM standard
 * deviations of its forward. A one-day 90% put is quoted, but its IV describes a
 * strike with no probability mass; drawing it as a wall beside a one-year smile
 * misrepresents the surface. Rows without an ATM IV are left untouched.
 */
export function windowSurfaceGrid(grid: SurfaceGrid, snapshot: SurfaceSnapshot, sigmas = SURFACE_SIGMA_WINDOW): SurfaceGrid {
  if (!(sigmas > 0)) return grid;
  const rows = grid.rows.map((row) => {
    const expiry = row.expiration == null ? null : snapshot.expiries.find((entry) => entry.expiration === row.expiration);
    const forward = row.forward ?? expiry?.forward ?? null;
    if (!expiry?.atmIV || !positive(forward) || !(row.years > 0)) return row;
    const width = sigmas * expiry.atmIV * Math.sqrt(row.years);
    return { ...row, cells: row.cells.map((cell) => {
      const k = positive(cell.strike) ? Math.abs(Math.log(cell.strike / forward)) : null;
      return k == null || k <= width + 1e-12 ? cell : { ...cell, volatility: null, fitResidual: null };
    }) };
  });
  return { ...grid, rows, volatilities: rows.map((row) => row.cells.map((cell) => cell.volatility)) };
}

/** A sparse far-wing fit cannot stand in for an observed near-ATM smile. */
export function evaluateSurfaceSmile(expiry: SurfaceExpiry, strike: number): number | null {
  const first = expiry.points[0], last = expiry.points.at(-1);
  if (!expiry.fit || !positive(expiry.forward) || !positive(strike) || !first || !last
    || strike < first.strike - 1e-8 || strike > last.strike + 1e-8) return null;
  return evaluateSmile(expiry.fit, logForwardMoneyness(strike, expiry.forward)!);
}

/**
 * The delta-neutral straddle strike, where d1 = 0 so the call and put deltas
 * mirror: K = F exp(sigma(K)^2 T / 2), solved by fixed point on the smile.
 * On a delta axis ATM must sit between 45P and 45C; spot does not once the
 * forward drifts away from it at long tenors.
 */
export function deltaNeutralStrike(forward: number, years: number, volatilityAt: (logMoneyness: number) => number | null): number | null {
  let k = 0;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const volatility = volatilityAt(k);
    if (volatility == null || !Number.isFinite(volatility)) return null;
    k = volatility * volatility * years / 2;
  }
  return forward * Math.exp(k);
}

function deltaStrike(expiry: SurfaceExpiry, spot: number, coordinate: number): number | null {
  if (!expiry.fit || expiry.forward === null || expiry.rate === null || expiry.dividendYield === null) return null;
  const fit = expiry.fit;
  if (coordinate === 0) return deltaNeutralStrike(expiry.forward, expiry.years, (k) => evaluateSmile(fit, k));
  const side = coordinate < 0 ? "put" : "call";
  const center = Math.log(expiry.forward);
  const at = (logStrike: number) => {
    const strike = Math.exp(logStrike);
    const volatility = evaluateSmile(fit, logStrike - center);
    return volatility == null ? null : optionDelta({ spot, years: expiry.years, rate: expiry.rate!,
      dividendYield: expiry.dividendYield!, volatility }, strike, side);
  };
  // Restrict delta labels to the observed strike domain, including in a fitted smile.
  let low = Math.log(expiry.points[0]!.strike), high = Math.log(expiry.points.at(-1)!.strike);
  let a = at(low), b = at(high);
  if (a == null || b == null || a < coordinate || b > coordinate) return null;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const mid = (low + high) / 2;
    const delta = at(mid);
    if (delta == null) return null;
    if (delta > coordinate) low = mid; else high = mid;
  }
  return Math.exp((low + high) / 2);
}

function cellAt(expiry: SurfaceExpiry, spot: number, coordinate: number, axis: NonNullable<SurfaceGridOptions["axis"]>): SurfaceCell {
  const strike = axis === "delta" ? deltaStrike(expiry, spot, coordinate)
    : axis === "strike" ? coordinate : axis === "forward" ? (expiry.forward == null ? null : expiry.forward * coordinate) : spot * coordinate;
  const volatility = positive(strike) ? evaluateSurfaceSmile(expiry, strike) : null;
  const point = positive(strike) ? expiry.points.reduce<SurfacePoint | null>((closest, item) =>
    !closest || Math.abs(item.strike - strike) < Math.abs(closest.strike - strike) ? item : closest, null) : null;
  return { coordinate, strike: positive(strike) ? strike : null, volatility, point, fitResidual: point?.fitResidual ?? null };
}

/** Fixed tenor interpolation is performed at a fixed forward log-moneyness. */
export function buildSurfaceGrid(snapshot: SurfaceSnapshot, options: SurfaceGridOptions = {}): SurfaceGrid {
  const axis = options.axis ?? "spot";
  const coordinates = [...(options.coordinates ?? (axis === "delta" ? SURFACE_DELTAS : axis === "strike"
    ? [...new Set(snapshot.expiries.flatMap((expiry) => expiry.points.map((point) => point.strike)))].sort((a, b) => a - b)
    : SURFACE_MONEYNESS))];
  const expiries = [...snapshot.expiries].sort((a, b) => a.years - b.years);
  let rows: SurfaceGridRow[] = expiries.map((expiry) => ({ expiration: expiry.expiration, years: expiry.years,
    rate: expiry.rate, dividendYield: expiry.dividendYield, forward: expiry.forward,
    label: new Date(expiry.expiration * 1000).toISOString().slice(0, 10), interpolated: false, extrapolated: false,
    cells: coordinates.map((coordinate) => cellAt(expiry, snapshot.spot, coordinate, axis)) }));
  if (options.tenors === "fixed") {
    const available = expiries.filter((expiry) => expiry.fit && expiry.forward != null && expiry.rate != null && expiry.dividendYield != null);
    rows = (options.fixedTenors ?? FIXED_VOLATILITY_TENORS).map((tenor) => {
      const rightIndex = available.findIndex((expiry) => expiry.years >= tenor.years);
      const left = rightIndex < 0 ? available.at(-1) : available[Math.max(0, rightIndex - 1)];
      const right = rightIndex < 0 ? left : available[rightIndex];
      const weight = !left || !right || left === right ? 0 : (tenor.years - left.years) / (right.years - left.years);
      const rate = left && right ? left.rate! + weight * (right.rate! - left.rate!) : null;
      const dividendYield = left && right ? left.dividendYield! + weight * (right.dividendYield! - left.dividendYield!) : null;
      const targetForward = rate != null && dividendYield != null ? snapshot.spot * Math.exp((rate - dividendYield) * tenor.years) : null;
      const at = (k: number) => interpolateTotalVariance(available.flatMap((expiry) => {
        const volatility = evaluateSurfaceSmile(expiry, expiry.forward! * Math.exp(k));
        return volatility == null ? [] : [{ years: expiry.years, volatility }];
      }), tenor.years);
      let extrapolated = false;
      const cells = coordinates.map((coordinate): SurfaceCell => {
        const unavailable = (): SurfaceCell => ({ coordinate, strike: null, volatility: null, point: null, fitResidual: null });
        if (!positive(targetForward) || rate === null || dividendYield === null) return unavailable();
        let strike: number | null = axis === "spot" ? snapshot.spot * coordinate : axis === "forward" ? targetForward * coordinate
          : axis === "strike" ? coordinate : deltaNeutralStrike(targetForward, tenor.years, (k) => at(k)?.volatility ?? null);
        if (strike === null) return unavailable();
        if (axis === "delta" && coordinate !== 0) {
          let low = Math.min(...available.map((expiry) => expiry.points[0]!.logMoneyness));
          let high = Math.max(...available.map((expiry) => expiry.points.at(-1)!.logMoneyness));
          const delta = (k: number) => {
            const value = at(k);
            return value == null ? null : optionDelta({ spot: snapshot.spot, years: tenor.years,
              rate, dividendYield, volatility: value.volatility }, targetForward * Math.exp(k), coordinate < 0 ? "put" : "call");
          };
          const a = delta(low), b = delta(high);
          if (a == null || b == null || a < coordinate || b > coordinate) return unavailable();
          for (let iteration = 0; iteration < 70; iteration += 1) {
            const mid = (low + high) / 2, value = delta(mid);
            if (value == null) return unavailable();
            if (value > coordinate) low = mid; else high = mid;
          }
          strike = targetForward * Math.exp((low + high) / 2);
        }
        const k = logForwardMoneyness(strike, targetForward);
        if (k === null) return unavailable();
        const value = at(k);
        extrapolated ||= value?.extrapolated ?? false;
        return { coordinate, strike, volatility: value?.volatility ?? null, point: null, fitResidual: null };
      });
      return { expiration: null, years: tenor.years, rate, dividendYield, forward: targetForward,
        label: tenor.label, interpolated: true, extrapolated, cells };
    });
  }
  return { rows, tenors: rows.map((row) => row.years), moneyness: coordinates,
    volatilities: rows.map((row) => row.cells.map((cell) => cell.volatility)) };
}
