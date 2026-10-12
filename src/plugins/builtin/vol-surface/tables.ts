import { findListedExpiry } from "../../../utils/option-expiry";
import { evaluateSurfaceSmile, type SurfaceExpiry, type SurfaceSnapshot } from "./model";

export const formatIv = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : `${(value * 100).toFixed(2)}%`;
export const formatPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
export const expiryLabel = (expiration: number) => new Date(expiration * 1000).toISOString().slice(0, 10);

/** A one-day front expiry is the noisiest smile on the board; the default selection is the first at least four weeks out. */
const DEFAULT_EXPIRY_MIN_DAYS = 28;
/** Annualising a few days of parity carry produces meaningless yields. */
const DIVIDEND_YIELD_MIN_DAYS = 30;
/**
 * Below this many days to expiry, the ATM term slope to the next expiry
 * annualises a few hours of IV change into hundreds of points a year.
 */
export const TERM_SLOPE_MIN_DAYS = 7;
/** What the Skew view prints in place of a slope it leaves out. */
export const HIDDEN_SLOPE_TEXT = `under ${TERM_SLOPE_MIN_DAYS}d`;
/** What the Forwards view prints in place of a dividend yield it leaves out. */
export const HIDDEN_YIELD_TEXT = `under ${DIVIDEND_YIELD_MIN_DAYS}d`;
/** A decimal IV difference in vol points, as the Skew view prints it. */
export const formatVolPoints = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "--" : (value * 100).toFixed(2);

/** Calendar days to the expiry's close, as the model prices it. */
const expiryDays = (expiry: Pick<SurfaceExpiry, "years">) => expiry.years * 365;

/**
 * The expiry the smile, chain and pricer actions use: the requested one,
 * matched by calendar date as OMON matches it, else the first at least four
 * weeks out. A requested expiry that is not loaded selects nothing.
 */
export function selectSurfaceExpiry(snapshot: Pick<SurfaceSnapshot, "expiries">, requested: number | null | undefined): SurfaceExpiry | null {
  if (requested != null) {
    const listed = findListedExpiry(requested, snapshot.expiries.map((entry) => entry.expiration));
    return snapshot.expiries.find((entry) => entry.expiration === listed) ?? null;
  }
  return snapshot.expiries.find((entry) => expiryDays(entry) >= DEFAULT_EXPIRY_MIN_DAYS) ?? snapshot.expiries[0] ?? null;
}

/**
 * Why an expiry has no 25-delta risk reversal or butterfly: no fitted smile,
 * or clean quotes that stop short of a 25-delta strike (the fit is never
 * extrapolated past them). Null when both are there, or while it loads.
 */
export function skewGap(expiry: SurfaceExpiry): string | null {
  const { put25, call25, riskReversal, butterfly } = expiry.skew;
  if (riskReversal != null && butterfly != null) return null;
  if (!expiry.fit) return expiry.state === "loading" ? null : "no smile fit";
  if (put25 == null && call25 == null) return "no 25D quotes";
  if (put25 == null) return "no 25D put";
  if (call25 == null) return "no 25D call";
  return "no ATM IV";
}

export interface SurfaceSkewRow {
  expiration: number;
  days: number;
  /** Decimal IVs at the 25-delta put and call. */
  put25: number | null;
  call25: number | null;
  /** Decimal IV differences: call minus put, wing average minus ATM, 90% of spot minus 110%. */
  riskReversal: number | null;
  butterfly: number | null;
  moneynessSkew: number | null;
  /** Decimal ATM IV change per year to the next expiry; null under TERM_SLOPE_MIN_DAYS, which `termSlopeHidden` marks. */
  termSlope: number | null;
  termSlopeHidden: boolean;
  /** Why the risk reversal and butterfly are missing. */
  gap: string | null;
  /** Why the 90/110 figure is missing. */
  moneynessGap: string | null;
}

export function surfaceSkewRow(expiry: SurfaceExpiry): SurfaceSkewRow {
  const days = expiryDays(expiry);
  const termSlopeHidden = expiry.termSlope != null && days < TERM_SLOPE_MIN_DAYS;
  return { expiration: expiry.expiration, days, put25: expiry.skew.put25, call25: expiry.skew.call25,
    riskReversal: expiry.skew.riskReversal, butterfly: expiry.skew.butterfly, moneynessSkew: expiry.skew.moneynessSkew,
    termSlope: termSlopeHidden ? null : expiry.termSlope, termSlopeHidden, gap: skewGap(expiry),
    // 90% and 110% of spot lie past the clean quotes of a near expiry.
    moneynessGap: expiry.skew.moneynessSkew != null ? null : !expiry.fit ? skewGap(expiry) : "not quoted" };
}

export interface SurfaceForwardRow {
  expiration: number;
  forward: number | null;
  /** Forward minus spot, in price. */
  basis: number | null;
  /** Decimal implied dividend yield; null under 30 days out, which `dividendYieldHidden` marks. */
  dividendYield: number | null;
  dividendYieldHidden: boolean;
  rate: number | null;
  /** Put-call pairs behind the forward; a stored close keeps the forward, not its pairs. */
  pairs: number | null;
}

export function surfaceForwardRow(expiry: SurfaceExpiry, snapshot: SurfaceSnapshot & { stored?: unknown }): SurfaceForwardRow {
  const dividendYieldHidden = expiry.dividendYield != null && expiryDays(expiry) < DIVIDEND_YIELD_MIN_DAYS;
  return { expiration: expiry.expiration, forward: expiry.forward, basis: expiry.forward == null ? null : expiry.forward - snapshot.spot,
    dividendYield: dividendYieldHidden ? null : expiry.dividendYield, dividendYieldHidden,
    rate: expiry.rate, pairs: snapshot.stored ? null : expiry.parity.pairs.length };
}

/** When and how an expiry's quotes were observed, as a report reads its freshness from each row. */
export const expiryFeedFields = (expiry: SurfaceExpiry) => ({
  asOf: expiry.asOf, dataSource: expiry.dataSource, delayMinutes: expiry.delayMinutes, stale: expiry.stale,
});

/** The Term view's points: ATM at spot and the 25-delta wings, with the expiry's straddle and one-sigma move. */
export function surfaceTermRows(snapshot: SurfaceSnapshot) {
  return snapshot.expiries.filter((expiry) => expiry.atmIV != null).sort((a, b) => a.years - b.years).map((expiry) => ({
    expiration: expiry.expiration, days: expiryDays(expiry), atm: expiry.atmIV, put25: expiry.skew.put25, call25: expiry.skew.call25,
    straddle: expiry.expectedMove.straddle, sigma: expiry.expectedMove.sigma, sigmaPercent: expiry.expectedMove.sigmaPercent,
    ...expiryFeedFields(expiry),
  }));
}

/** The Smile view's clean quotes against the fitted smile, in strike order. */
export function surfaceSmileRows(expiry: SurfaceExpiry) {
  return expiry.points.map((point) => ({ strike: point.strike, side: point.side, moneyness: point.moneyness,
    volatility: point.volatility, fitted: evaluateSurfaceSmile(expiry, point.strike), residual: point.fitResidual,
    mid: point.mid, openInterest: point.openInterest }));
}
