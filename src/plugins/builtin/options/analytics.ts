import type { PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import type { OptionContract, OptionsChain, PricePoint } from "../../../types/financials";
import {
  extractImpliedForward,
  forwardFromCarry,
  optionMid,
  realizedVolatilityCadenceIssue,
  realizedVolatilityResult,
} from "../shared/volatility";
import {
  DEFAULT_OPTION_CALC_DRAFT,
  daysToExpiryFrom,
  solveImpliedVolatility,
  valueOption,
  type OptionSide,
  type OptionValuation,
} from "../options-calculator/model";
import { optionQuoteValuationTime } from "../vol-surface/model";

const HISTORICAL_VOLATILITY_SESSIONS = 30;

export interface OptionsSummary {
  atmImpliedVolatility: number | null;
  historicalVolatility30d: number | null;
  historicalVolatilityUnavailableReason?: string;
  historicalVolatilityIntegrity?: PriceHistoryIntegrity;
  impliedHistoricalRatio: number | null;
  expirationVolume: number | null;
  putCallVolumeRatio: number | null;
  putCallOpenInterestRatio: number | null;
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator != null && denominator != null && denominator > 0 ? numerator / denominator : null;
}

function sum(contracts: readonly OptionContract[], field: "volume" | "openInterest"): number | null {
  let total = 0;
  for (const contract of contracts) {
    const value = contract[field];
    if (value == null || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

/** Implied volatility per strike of one expiry, shared by its call and put. */
export interface ChainVolatilities {
  /** Valuation instant the volatilities were solved at, reused for the Greeks. */
  valuationTime: number;
  byStrike: ReadonlyMap<number, number>;
}

function tightestQuotes(contracts: readonly OptionContract[], expiration: number): Map<number, OptionContract> {
  const quotes = new Map<number, OptionContract>();
  for (const contract of contracts) {
    if (contract.expiration !== expiration || !positive(contract.strike) || optionMid(contract) == null) continue;
    const current = quotes.get(contract.strike);
    if (!current || contract.ask - contract.bid < current.ask - current.bid) quotes.set(contract.strike, contract);
  }
  return quotes;
}

/**
 * Solve IV from quote midpoints the way OVDV does: calendar time to the 16:00 ET
 * close, the put-call parity forward, and the out-of-the-money side of each
 * strike, so a call and put share one volatility. Vendor IVs are not used: they
 * can be placeholders (1e-5) and, for same-day expiries, sit on a trading-time
 * basis that reads well under half the calendar-time value.
 */
export function solveChainVolatilities(
  chain: OptionsChain,
  spot: number | undefined,
  dividendYield: number | undefined,
  now: number = Date.now(),
): ChainVolatilities {
  const valuationTime = optionQuoteValuationTime(chain, now);
  const byStrike = new Map<number, number>();
  if (!positive(spot)) return { valuationTime, byStrike };
  const rate = DEFAULT_OPTION_CALC_DRAFT.rate;
  const carry = Number.isFinite(dividendYield) ? dividendYield! : 0;
  const expirations = new Set([...chain.calls, ...chain.puts].map((contract) => contract.expiration));
  for (const expiration of expirations) {
    const years = daysToExpiryFrom(expiration, valuationTime) / 365;
    if (!(years > 0)) continue;
    const calls = tightestQuotes(chain.calls, expiration);
    const puts = tightestQuotes(chain.puts, expiration);
    const forward = extractImpliedForward([...calls.values()], [...puts.values()], spot, years, rate, chain.underlyingSymbol).forward
      ?? forwardFromCarry(spot, years, rate, carry);
    if (forward == null) continue;
    const discount = Math.exp(-rate * years);
    // q=r turns the shared spot pricer into discounted forward pricing.
    const solve = (side: OptionSide, contract: OptionContract | undefined, inTheMoney: boolean): number | null => {
      const mid = contract ? optionMid(contract) : null;
      if (mid == null) return null;
      const { strike, bid, ask } = contract!;
      // Deep in the money, time value inside the quoted spread is noise, not optionality.
      const intrinsic = Math.max(0, (side === "call" ? forward - strike : strike - forward) * discount);
      if (inTheMoney && mid - intrinsic <= ask - bid) return 0;
      const solved = solveImpliedVolatility({ ...DEFAULT_OPTION_CALC_DRAFT, side, spot: forward, strike,
        daysToExpiry: years * 365, rate, dividendYield: rate }, mid).volatility;
      return solved != null && Number.isFinite(solved) && solved > 0 ? solved : null;
    };
    for (const strike of new Set([...calls.keys(), ...puts.keys()])) {
      const call = calls.get(strike);
      const put = puts.get(strike);
      const volatility = strike >= forward ? solve("call", call, false) ?? solve("put", put, true)
        : solve("put", put, false) ?? solve("call", call, true);
      if (volatility != null) byStrike.set(strike, volatility);
    }
  }
  return { valuationTime, byStrike };
}

function atmImpliedVolatility(volatilities: ChainVolatilities, spot: number | undefined): number | null {
  if (!positive(spot)) return null;
  const strikes = [...volatilities.byStrike].filter(([, volatility]) => volatility > 0);
  if (strikes.length === 0) return null;
  const distance = Math.min(...strikes.map(([strike]) => Math.abs(strike - spot)));
  const atTheMoney = strikes
    .filter(([strike]) => Math.abs(Math.abs(strike - spot) - distance) < 1e-8)
    .map(([, volatility]) => volatility);
  return atTheMoney.reduce((total, value) => total + value, 0) / atTheMoney.length;
}

interface HistoricalVolatilityResult {
  value: number | null;
  unavailableReason?: string;
  integrity?: PriceHistoryIntegrity;
}

function historicalVolatilityResult(points: readonly PricePoint[]): HistoricalVolatilityResult {
  const cadenceIssue = realizedVolatilityCadenceIssue(points);
  if (cadenceIssue) return { value: null, unavailableReason: `HV30 unavailable: ${cadenceIssue}` };
  const result = realizedVolatilityResult(points, HISTORICAL_VOLATILITY_SESSIONS, "close-to-close");
  const reason = result.reason === "invalid-date" ? "invalid history date"
    : result.reason === "inconsistent-ohlc" ? "inconsistent OHLC history"
    : result.reason === "missing-close" ? "missing or nonpositive close"
    : result.reason && result.reason !== "insufficient-history" ? result.reason.replaceAll("-", " ") : null;
  return { value: result.value,
    ...(reason ? { unavailableReason: `HV30 unavailable: ${reason}` } : {}),
    ...(result.integrity ? { integrity: result.integrity } : {}) };
}

/** Annualized sample standard deviation of the latest 30 daily log returns. */
export function historicalVolatility30d(points: readonly PricePoint[]): number | null {
  return historicalVolatilityResult(points).value;
}

export function calculateOptionsSummary(
  chain: OptionsChain,
  spot: number | undefined,
  priceHistory: readonly PricePoint[],
  volatilities: ChainVolatilities,
): OptionsSummary {
  const atmIv = atmImpliedVolatility(volatilities, spot);
  const historical = historicalVolatilityResult(priceHistory);
  const historicalVolatility = historical.value;
  const callVolume = sum(chain.calls, "volume");
  const putVolume = sum(chain.puts, "volume");
  const callOpenInterest = sum(chain.calls, "openInterest");
  const putOpenInterest = sum(chain.puts, "openInterest");

  return {
    atmImpliedVolatility: atmIv,
    historicalVolatility30d: historicalVolatility,
    ...(historical.unavailableReason ? { historicalVolatilityUnavailableReason: historical.unavailableReason } : {}),
    ...(historical.integrity ? { historicalVolatilityIntegrity: historical.integrity } : {}),
    impliedHistoricalRatio: atmIv != null && historicalVolatility != null && historicalVolatility > 0
      ? atmIv / historicalVolatility
      : null,
    expirationVolume: callVolume != null && putVolume != null ? callVolume + putVolume : null,
    putCallVolumeRatio: ratio(putVolume, callVolume),
    putCallOpenInterestRatio: ratio(putOpenInterest, callOpenInterest),
  };
}

/** Greeks at the displayed spot, from the strike's solved volatility (0 when the market prices no time value). */
export function calculateOptionGreeks(
  contract: OptionContract | undefined,
  side: OptionSide,
  spot: number | undefined,
  dividendYield: number | undefined,
  volatilities: ChainVolatilities,
): OptionValuation | undefined {
  const volatility = contract ? volatilities.byStrike.get(contract.strike) : undefined;
  if (!contract || !positive(spot) || !positive(contract.strike) || volatility == null || !(volatility >= 0)) {
    return undefined;
  }
  return valueOption({
    ...DEFAULT_OPTION_CALC_DRAFT,
    side,
    spot,
    strike: contract.strike,
    daysToExpiry: daysToExpiryFrom(contract.expiration, volatilities.valuationTime),
    volatility,
    dividendYield: Number.isFinite(dividendYield) ? dividendYield! : 0,
  });
}
