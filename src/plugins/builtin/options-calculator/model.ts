import { zonedWallClockToUtcMs } from "../../../utils/zoned-date-time";

export const OPTIONS_CALCULATOR_PANE_ID = "options-calculator";
export const OPTIONS_CALCULATOR_TEMPLATE_ID = "options-calculator-pane";
const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const OPTION_EXPIRY_TIME_ZONE = "America/New_York";
const MIN_VOLATILITY = 1e-6;
const MAX_VOLATILITY = 5;

export type OptionSide = "call" | "put";

export interface OptionCalcDraft {
  symbol: string;
  side: OptionSide;
  spot: number;
  strike: number;
  daysToExpiry: number;
  /** Continuously compounded, as a decimal (0.05 = 5%). */
  rate: number;
  volatility: number;
  dividendYield: number;
  /** 0 means "not supplied", which is also the only price no option can trade at. */
  marketPrice: number;
}

export const DEFAULT_OPTION_CALC_DRAFT: OptionCalcDraft = {
  symbol: "",
  side: "call",
  spot: 100,
  strike: 100,
  daysToExpiry: 30,
  rate: 0.04,
  volatility: 0.25,
  dividendYield: 0,
  marketPrice: 0,
};

export interface OptionValuation {
  price: number;
  delta: number;
  gamma: number;
  /** Value decay for one calendar day. */
  thetaPerDay: number;
  /** Value change for one volatility point (1%). */
  vegaPerPoint: number;
  /** Value change for one rate point (1%). */
  rhoPerPoint: number;
}

const ZERO_GREEKS = { delta: 0, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0, rhoPerPoint: 0 };

/** Abramowitz & Stegun 26.2.17; |error| < 7.5e-8, well inside display precision. */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-z * z)));
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Value with no optionality left: the discounted forward payoff. Covers expiry,
 * zero volatility, and a zero spot or strike, all of which make the
 * Black-Scholes ratios divide by zero.
 */
function intrinsicValuation(
  side: OptionSide,
  spot: number,
  strike: number,
  years: number,
  rate: number,
  dividendYield: number,
): OptionValuation {
  const discountedSpot = spot * Math.exp(-dividendYield * years);
  const discountedStrike = strike * Math.exp(-rate * years);
  const inTheMoney = side === "call" ? discountedSpot > discountedStrike : discountedStrike > discountedSpot;
  const price = side === "call"
    ? Math.max(0, discountedSpot - discountedStrike)
    : Math.max(0, discountedStrike - discountedSpot);
  return {
    ...ZERO_GREEKS,
    price,
    delta: inTheMoney ? (side === "call" ? Math.exp(-dividendYield * years) : -Math.exp(-dividendYield * years)) : 0,
  };
}

/** Black-Scholes-Merton for European calls and puts with a continuous dividend yield. */
export function valueOption(draft: OptionCalcDraft): OptionValuation {
  const spot = Math.max(0, finite(draft.spot));
  const strike = Math.max(0, finite(draft.strike));
  const years = Math.max(0, finite(draft.daysToExpiry)) / DAYS_PER_YEAR;
  const rate = finite(draft.rate);
  const dividendYield = finite(draft.dividendYield);
  const volatility = Math.max(0, finite(draft.volatility));
  const { side } = draft;

  if (years <= 0 || volatility <= 0 || spot <= 0 || strike <= 0) {
    return intrinsicValuation(side, spot, strike, years, rate, dividendYield);
  }

  const sqrtYears = Math.sqrt(years);
  const carryFactor = Math.exp(-dividendYield * years);
  const discountFactor = Math.exp(-rate * years);
  const d1 = (Math.log(spot / strike) + (rate - dividendYield + volatility * volatility / 2) * years)
    / (volatility * sqrtYears);
  const d2 = d1 - volatility * sqrtYears;
  const pdf = normalPdf(d1);

  const price = side === "call"
    ? spot * carryFactor * normalCdf(d1) - strike * discountFactor * normalCdf(d2)
    : strike * discountFactor * normalCdf(-d2) - spot * carryFactor * normalCdf(-d1);

  const thetaPerYear = side === "call"
    ? -(spot * pdf * volatility * carryFactor) / (2 * sqrtYears)
      - rate * strike * discountFactor * normalCdf(d2)
      + dividendYield * spot * carryFactor * normalCdf(d1)
    : -(spot * pdf * volatility * carryFactor) / (2 * sqrtYears)
      + rate * strike * discountFactor * normalCdf(-d2)
      - dividendYield * spot * carryFactor * normalCdf(-d1);

  const rhoPerUnit = side === "call"
    ? strike * years * discountFactor * normalCdf(d2)
    : -strike * years * discountFactor * normalCdf(-d2);

  return {
    price: Math.max(0, price),
    delta: side === "call" ? carryFactor * normalCdf(d1) : carryFactor * (normalCdf(d1) - 1),
    gamma: carryFactor * pdf / (spot * volatility * sqrtYears),
    thetaPerDay: thetaPerYear / DAYS_PER_YEAR,
    vegaPerPoint: spot * carryFactor * pdf * sqrtYears / 100,
    rhoPerPoint: rhoPerUnit / 100,
  };
}

export interface ImpliedVolatilityResult {
  volatility: number | null;
  /** Why no volatility could be solved, phrased for the pane body. */
  note: string | null;
}

/**
 * Price rises monotonically with volatility, so bisection always converges and
 * cannot diverge the way a Newton step can near zero vega. The arbitrage bounds
 * are checked first: outside them no volatility exists at all.
 */
export function solveImpliedVolatility(
  draft: OptionCalcDraft,
  marketPrice: number,
): ImpliedVolatilityResult {
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { volatility: null, note: null };
  if (!(draft.daysToExpiry > 0)) return { volatility: null, note: "expired, no implied volatility" };
  if (!(draft.spot > 0) || !(draft.strike > 0)) return { volatility: null, note: "needs a positive spot and strike" };

  const years = draft.daysToExpiry / DAYS_PER_YEAR;
  const discountedSpot = draft.spot * Math.exp(-draft.dividendYield * years);
  const discountedStrike = draft.strike * Math.exp(-draft.rate * years);
  const lowerBound = draft.side === "call"
    ? Math.max(0, discountedSpot - discountedStrike)
    : Math.max(0, discountedStrike - discountedSpot);
  const upperBound = draft.side === "call" ? discountedSpot : discountedStrike;
  if (marketPrice < lowerBound - 1e-8) {
    return { volatility: null, note: "market price is below intrinsic value" };
  }
  if (marketPrice > upperBound + 1e-8) {
    return { volatility: null, note: "market price is above the no-arbitrage maximum" };
  }

  const priceAt = (volatility: number) => valueOption({ ...draft, volatility }).price;
  const floor = priceAt(MIN_VOLATILITY);
  const cap = priceAt(MAX_VOLATILITY);
  if (marketPrice < floor - 1e-8) return { volatility: null, note: "market price is below intrinsic value" };
  if (marketPrice > cap) return { volatility: null, note: `market price implies volatility above ${MAX_VOLATILITY * 100}%` };

  let low = MIN_VOLATILITY;
  let high = MAX_VOLATILITY;
  for (let i = 0; i < 100 && high - low > 1e-8; i += 1) {
    const mid = (low + high) / 2;
    if (priceAt(mid) > marketPrice) high = mid;
    else low = mid;
  }
  return { volatility: (low + high) / 2, note: null };
}

export function describeDraftProblem(draft: OptionCalcDraft): string | null {
  if (!(draft.spot > 0)) return "Spot must be positive.";
  if (!(draft.strike > 0)) return "Strike must be positive.";
  if (draft.daysToExpiry < 0) return "Days to expiry cannot be negative.";
  if (draft.volatility < 0) return "Volatility cannot be negative.";
  return null;
}

/** Time to the option date's 16:00 ET close, preserving live 0DTE time value. */
export function daysToExpiryFrom(expirationSeconds: number, now: number): number {
  if (!Number.isFinite(expirationSeconds)) return 0;
  const expirationDate = new Date(expirationSeconds * 1000);
  const close = zonedWallClockToUtcMs(
    OPTION_EXPIRY_TIME_ZONE,
    expirationDate.getUTCFullYear(),
    expirationDate.getUTCMonth() + 1,
    expirationDate.getUTCDate(),
    16,
    0,
    0,
  );
  return Math.max(0, (close - now) / DAY_MS);
}

export interface OptionCalcSeed {
  symbol?: string | null;
  side?: OptionSide | null;
  spot?: number | null;
  strike?: number | null;
  /** Unix seconds, as options chains report it. */
  expiration?: number | null;
  volatility?: number | null;
  dividendYield?: number | null;
  marketPrice?: number | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function buildOptionCalcParams(
  seed: OptionCalcSeed,
  now: number = Date.now(),
): Record<string, string> {
  const params: Record<string, string> = {};
  if (seed.symbol) params.symbol = seed.symbol.toUpperCase();
  if (seed.side) params.side = seed.side;
  const spot = positive(seed.spot);
  const strike = positive(seed.strike);
  const volatility = positive(seed.volatility);
  const marketPrice = positive(seed.marketPrice);
  if (spot != null) params.spot = String(spot);
  if (strike != null) params.strike = String(strike);
  if (seed.expiration != null) params.days = String(daysToExpiryFrom(seed.expiration, now));
  if (volatility != null) params.volatility = String(volatility);
  if (marketPrice != null) params.marketPrice = String(marketPrice);
  if (seed.dividendYield != null && Number.isFinite(seed.dividendYield) && seed.dividendYield > 0) {
    params.dividendYield = String(seed.dividendYield);
  }
  return params;
}

function numberParam(params: Record<string, string>, key: string, fallback: number): number {
  const parsed = Number(params[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function draftFromParams(params: Record<string, string> | undefined): OptionCalcDraft {
  if (!params) return DEFAULT_OPTION_CALC_DRAFT;
  return {
    symbol: params.symbol ?? DEFAULT_OPTION_CALC_DRAFT.symbol,
    side: params.side === "put" ? "put" : "call",
    spot: numberParam(params, "spot", DEFAULT_OPTION_CALC_DRAFT.spot),
    strike: numberParam(params, "strike", DEFAULT_OPTION_CALC_DRAFT.strike),
    daysToExpiry: numberParam(params, "days", DEFAULT_OPTION_CALC_DRAFT.daysToExpiry),
    rate: numberParam(params, "rate", DEFAULT_OPTION_CALC_DRAFT.rate),
    volatility: numberParam(params, "volatility", DEFAULT_OPTION_CALC_DRAFT.volatility),
    dividendYield: numberParam(params, "dividendYield", DEFAULT_OPTION_CALC_DRAFT.dividendYield),
    marketPrice: numberParam(params, "marketPrice", DEFAULT_OPTION_CALC_DRAFT.marketPrice),
  };
}
