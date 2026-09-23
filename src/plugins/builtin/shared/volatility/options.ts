import { DEFAULT_OPTION_CALC_DRAFT, valueOption, type OptionSide } from "../../options-calculator/model";

export interface VolatilityInputs {
  spot: number;
  years: number;
  volatility: number;
  rate: number;
  dividendYield?: number;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;

function validInputs(input: VolatilityInputs): boolean {
  return positive(input.spot) && positive(input.years) && positive(input.volatility)
    && Number.isFinite(input.rate) && Number.isFinite(input.dividendYield ?? 0);
}

/** Spot delta, including continuous dividend carry, from the shared pricer. */
export function optionDelta(input: VolatilityInputs, strike: number, side: OptionSide): number | null {
  if (!validInputs(input) || !positive(strike)) return null;
  const delta = valueOption({ ...DEFAULT_OPTION_CALC_DRAFT, ...input, strike, side,
    daysToExpiry: input.years * 365, dividendYield: input.dividendYield ?? 0 }).delta;
  return Number.isFinite(delta) ? delta : null;
}

/** Signed spot delta: a 25-delta put is -0.25. Unreachable targets return null. */
export function strikeForDelta(input: VolatilityInputs, target: number, side: OptionSide): number | null {
  if (!validInputs(input) || !Number.isFinite(target)) return null;
  const carry = Math.exp(-(input.dividendYield ?? 0) * input.years);
  if (side === "call" ? target <= 0 || target >= carry : target >= 0 || target <= -carry) return null;
  const center = Math.log(input.spot) + (input.rate - (input.dividendYield ?? 0)) * input.years;
  const radius = Math.max(2, 12 * input.volatility * Math.sqrt(input.years) + input.volatility ** 2 * input.years);
  let low = center - radius;
  let high = center + radius;
  const lowDelta = optionDelta(input, Math.exp(low), side);
  const highDelta = optionDelta(input, Math.exp(high), side);
  if (lowDelta == null || highDelta == null || target > lowDelta || target < highDelta) return null;
  for (let i = 0; i < 100; i += 1) {
    const mid = (low + high) / 2;
    const delta = optionDelta(input, Math.exp(mid), side);
    if (delta == null) return null;
    if (delta > target) low = mid;
    else high = mid;
  }
  const strike = Math.exp((low + high) / 2);
  return positive(strike) ? strike : null;
}

export function forwardFromCarry(spot: number, years: number, rate: number, dividendYield = 0): number | null {
  if (!positive(spot) || !Number.isFinite(years) || years < 0 || !Number.isFinite(rate) || !Number.isFinite(dividendYield)) return null;
  const forward = spot * Math.exp((rate - dividendYield) * years);
  return positive(forward) ? forward : null;
}

export function logForwardMoneyness(strike: number, forward: number): number | null {
  return positive(strike) && positive(forward) ? Math.log(strike) - Math.log(forward) : null;
}

export function strikeFromLogMoneyness(logMoneyness: number, forward: number): number | null {
  if (!positive(forward) || !Number.isFinite(logMoneyness)) return null;
  const strike = Math.exp(Math.log(forward) + logMoneyness);
  return positive(strike) ? strike : null;
}

export interface ParityQuote { strike: number; bid: number; ask: number; contractSymbol?: string }

/** Crossed, empty and one-sided markets cannot supply a midpoint. */
export function optionMid(quote: Pick<ParityQuote, "bid" | "ask">): number | null {
  return positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid
    ? quote.bid + (quote.ask - quote.bid) / 2 : null;
}

export interface ParityPair {
  strike: number;
  forward: number;
  forwardBid: number;
  forwardAsk: number;
  call: string | null;
  put: string | null;
}

export interface ImpliedForward {
  forward: number | null;
  dividendYield: number | null;
  pairs: ParityPair[];
  method: "put-call-parity" | "unavailable";
  warnings: string[];
}

/**
 * Largest log gap between a parity forward and spot grown at the risk-free rate:
 * 5% for spot and chain observed at different times plus 100% a year of
 * dividend and borrow carry. Stale quotes left on far strikes (for example
 * contracts listed before a split) otherwise produce forwards several times spot.
 */
export function maxParityCarryLogGap(years: number): number {
  return 0.05 + Math.max(0, years);
}

/** Use the two nearest valid paired strikes on each side of spot, then their median. */
export function extractImpliedForward(
  calls: readonly ParityQuote[], puts: readonly ParityQuote[], spot: number, years: number, rate: number,
): ImpliedForward {
  const unavailable = (reason: string): ImpliedForward => ({ forward: null, dividendYield: null,
    pairs: [], method: "unavailable", warnings: [reason] });
  if (!positive(spot) || !positive(years) || !Number.isFinite(rate)) return unavailable("Invalid parity inputs");
  const growth = Math.exp(rate * years);
  if (!positive(growth)) return unavailable("Parity discount factor exceeds model precision");
  // Repeated strikes choose the tightest valid quote, independent of provider order.
  const quotesByStrike = (quotes: readonly ParityQuote[]) => {
    const map = new Map<number, ParityQuote>();
    for (const quote of quotes) {
      if (!positive(quote.strike) || optionMid(quote) == null) continue;
      const current = map.get(quote.strike);
      if (!current || quote.ask - quote.bid < current.ask - current.bid) map.set(quote.strike, quote);
    }
    return map;
  };
  const putMap = quotesByStrike(puts);
  const candidates: ParityPair[] = [];
  const maxGap = maxParityCarryLogGap(years);
  let implausible = 0;
  for (const call of quotesByStrike(calls).values()) {
    const put = putMap.get(call.strike);
    if (!put) continue;
    const forward = call.strike + (optionMid(call)! - optionMid(put)!) * growth;
    const forwardBid = call.strike + (call.bid - put.ask) * growth;
    const forwardAsk = call.strike + (call.ask - put.bid) * growth;
    if (![forward, forwardBid, forwardAsk].every(positive)) continue;
    if (Math.abs(Math.log(forward / spot) - rate * years) > maxGap) { implausible += 1; continue; }
    candidates.push({ strike: call.strike, forward, forwardBid, forwardAsk,
      call: call.contractSymbol ?? null, put: put.contractSymbol ?? null });
  }
  const below = candidates.filter((pair) => pair.strike <= spot).sort((a, b) => b.strike - a.strike).slice(0, 2);
  const above = candidates.filter((pair) => pair.strike > spot).sort((a, b) => a.strike - b.strike).slice(0, 2);
  const pairs = [...below, ...above].sort((a, b) => a.strike - b.strike);
  if (!pairs.length) {
    return unavailable(implausible ? "Parity forwards are inconsistent with spot" : "No paired two-sided quotes for put-call parity");
  }
  const forwards = pairs.map((pair) => pair.forward).sort((a, b) => a - b);
  const middle = Math.floor(forwards.length / 2);
  const forward = forwards.length % 2 ? forwards[middle]! : forwards[middle - 1]! / 2 + forwards[middle]! / 2;
  const dividendYield = rate - (Math.log(forward) - Math.log(spot)) / years;
  if (!Number.isFinite(dividendYield)) return unavailable("Implied carry exceeds model precision");
  const warnings: string[] = [];
  if (!below.length || !above.length) warnings.push("Parity strikes do not bracket spot");
  if (Math.max(...pairs.map((pair) => pair.forwardBid)) > Math.min(...pairs.map((pair) => pair.forwardAsk))) {
    warnings.push("Parity forward quote intervals disagree");
  }
  return { forward, dividendYield, pairs, method: "put-call-parity", warnings };
}

export interface ExpectedMove {
  straddle: number | null;
  straddlePercent: number | null;
  sigma: number | null;
  sigmaPercent: number | null;
  strike: number | null;
}

/** Percent values are percentage points of spot; sigma is spot * IV * sqrt(T). */
export function expectedMove(
  calls: readonly ParityQuote[], puts: readonly ParityQuote[], spot: number, years: number, atmIv: number | null,
): ExpectedMove {
  if (!positive(spot) || !Number.isFinite(years) || years < 0) {
    return { straddle: null, straddlePercent: null, sigma: null, sigmaPercent: null, strike: null };
  }
  const putMap = new Map(puts.filter((put) => optionMid(put) != null).map((put) => [put.strike, put]));
  const pairs = calls.flatMap((call) => {
    const callMid = optionMid(call);
    const put = putMap.get(call.strike);
    const straddle = callMid != null && put ? callMid + optionMid(put)! : null;
    return positive(call.strike) && straddle != null && Number.isFinite(straddle)
      ? [{ strike: call.strike, straddle }] : [];
  }).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  // A far-wing straddle mainly measures intrinsic value, not an ATM expected move.
  const atm = pairs[0] && Math.abs(pairs[0].strike - spot) <= spot * (0.05 + 8 * Number.EPSILON) ? pairs[0] : null;
  const sigma = atmIv != null && Number.isFinite(atmIv) && atmIv >= 0 ? spot * atmIv * Math.sqrt(years) : null;
  return { straddle: atm?.straddle ?? null, straddlePercent: atm ? atm.straddle / spot * 100 : null,
    sigma: sigma != null && Number.isFinite(sigma) ? sigma : null,
    sigmaPercent: sigma != null && Number.isFinite(sigma) ? sigma / spot * 100 : null, strike: atm?.strike ?? null };
}

export interface SkewMetrics {
  put25: number | null;
  call25: number | null;
  atm: number | null;
  putCallSkew: number | null;
  riskReversal: number | null;
  butterfly: number | null;
  moneynessSkew: number | null;
}

/** Smile accepts absolute strike. All differences are in decimal annualized IV. */
export function smileSkew(input: Omit<VolatilityInputs, "volatility">, smile: (strike: number) => number | null): SkewMetrics {
  if (!validInputs({ ...input, volatility: 1 })) {
    return { atm: null, put25: null, call25: null, putCallSkew: null,
      riskReversal: null, butterfly: null, moneynessSkew: null };
  }
  const atm = smile(input.spot);
  const deltaVol = (side: OptionSide, target: number): number | null => {
    if (!positive(input.spot) || !positive(input.years)) return null;
    const center = Math.log(input.spot);
    let radius = 1;
    let low = center - radius;
    let high = center + radius;
    const at = (logStrike: number) => {
      const strike = Math.exp(logStrike);
      const volatility = smile(strike);
      return volatility == null ? null : optionDelta({ ...input, volatility }, strike, side);
    };
    let a = at(low), b = at(high);
    // Wide or strongly carried smiles can put a wing beyond twenty times spot.
    // Expand until a root is bracketed; a missing smile observation stays missing.
    for (let i = 0; i < 10 && a != null && b != null && (a < target || b > target); i += 1) {
      radius *= 2;
      low = center - radius;
      high = center + radius;
      a = at(low);
      b = at(high);
    }
    if (a == null || b == null || a < target || b > target) return null;
    for (let i = 0; i < 80; i += 1) {
      const mid = (low + high) / 2;
      const delta = at(mid);
      if (delta == null) return null;
      if (delta > target) low = mid; else high = mid;
    }
    return smile(Math.exp((low + high) / 2));
  };
  const put25 = deltaVol("put", -0.25), call25 = deltaVol("call", 0.25);
  const low = smile(input.spot * 0.9), high = smile(input.spot * 1.1);
  const both = put25 != null && call25 != null;
  return { atm, put25, call25, putCallSkew: both ? put25 - call25 : null,
    riskReversal: both ? call25 - put25 : null,
    butterfly: both && atm != null ? (call25 + put25) / 2 - atm : null,
    moneynessSkew: low != null && high != null ? low - high : null };
}

/** Decimal IV change per year between two tenors. */
export function volatilityTermSlope(front: { years: number; volatility: number }, back: { years: number; volatility: number }): number | null {
  return positive(front.years) && back.years > front.years && Number.isFinite(back.years)
    && Number.isFinite(front.volatility) && front.volatility >= 0 && Number.isFinite(back.volatility) && back.volatility >= 0
    ? (back.volatility - front.volatility) / (back.years - front.years) : null;
}
