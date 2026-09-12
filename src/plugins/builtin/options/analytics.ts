import { mergePriceHistoryIntegrity, pricePointIntegrity, type PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import type { OptionContract, OptionsChain, PricePoint } from "../../../types/financials";
import {
  DEFAULT_OPTION_CALC_DRAFT,
  daysToExpiryFrom,
  valueOption,
  type OptionSide,
  type OptionValuation,
} from "../options-calculator/model";

const TRADING_DAYS_PER_YEAR = 252;
const HISTORICAL_VOLATILITY_SESSIONS = 30;

export interface OptionsSummary {
  atmImpliedVolatility: number | null;
  historicalVolatility30d: number | null;
  historicalVolatilityUnavailableReason?: string;
  historicalVolatilityIntegrity?: PriceHistoryIntegrity;
  impliedHistoricalRatio: number | null;
  expirationVolume: number;
  putCallVolumeRatio: number | null;
  putCallOpenInterestRatio: number | null;
}

function positive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function sum(contracts: readonly OptionContract[], field: "volume" | "openInterest"): number {
  return contracts.reduce((total, contract) => {
    const value = contract[field];
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

function atmImpliedVolatility(chain: OptionsChain, spot: number | undefined): number | null {
  if (!positive(spot)) return null;
  const contracts = [...chain.calls, ...chain.puts].filter((contract) => positive(contract.impliedVolatility));
  if (contracts.length === 0) return null;
  const distance = Math.min(...contracts.map((contract) => Math.abs(contract.strike - spot)));
  const atTheMoney = contracts
    .filter((contract) => Math.abs(Math.abs(contract.strike - spot) - distance) < 1e-8)
    .map((contract) => contract.impliedVolatility);
  return atTheMoney.reduce((total, value) => total + value, 0) / atTheMoney.length;
}

interface HistoricalVolatilityResult {
  value: number | null;
  unavailableReason?: string;
  integrity?: PriceHistoryIntegrity;
}

/** Select observations before validating prices; a rejected close must never be bridged. */
function historicalVolatilityResult(points: readonly PricePoint[]): HistoricalVolatilityResult {
  const observations = new Map<number, PricePoint>();
  for (const point of points) {
    const time = new Date(point.date).getTime();
    if (!Number.isFinite(time)) {
      return { value: null, unavailableReason: "HV30 unavailable: invalid history date" };
    }
    // Persisted corrections replace the same observation, not an extra return.
    observations.set(time, point);
  }
  const selected = [...observations.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-(HISTORICAL_VOLATILITY_SESSIONS + 1))
    .map(([, point]) => point);
  const rejected = selected.flatMap((point) => {
    const integrity = pricePointIntegrity(point);
    return integrity ? [integrity] : [];
  });
  if (rejected.length > 0) {
    return {
      value: null,
      unavailableReason: "HV30 unavailable: inconsistent OHLC history",
      integrity: mergePriceHistoryIntegrity(...rejected),
    };
  }
  if (selected.some((point) => !positive(point.close))) {
    return { value: null, unavailableReason: "HV30 unavailable: missing or nonpositive close" };
  }
  if (selected.length < HISTORICAL_VOLATILITY_SESSIONS + 1) return { value: null };
  // Subtract logs instead of taking a ratio that can overflow for finite prices.
  const logs = selected.map((point) => Math.log(point.close));
  const returns = logs.slice(1).map((log, index) => log - logs[index]!);
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1);
  return { value: Math.sqrt(variance * TRADING_DAYS_PER_YEAR) };
}

/** Annualized sample standard deviation of the latest 30 daily log returns. */
export function historicalVolatility30d(points: readonly PricePoint[]): number | null {
  return historicalVolatilityResult(points).value;
}

export function calculateOptionsSummary(
  chain: OptionsChain,
  spot: number | undefined,
  priceHistory: readonly PricePoint[],
): OptionsSummary {
  const atmIv = atmImpliedVolatility(chain, spot);
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
    expirationVolume: callVolume + putVolume,
    putCallVolumeRatio: ratio(putVolume, callVolume),
    putCallOpenInterestRatio: ratio(putOpenInterest, callOpenInterest),
  };
}

export function calculateOptionGreeks(
  contract: OptionContract | undefined,
  side: OptionSide,
  spot: number | undefined,
  dividendYield: number | undefined,
  now: number = Date.now(),
): OptionValuation | undefined {
  if (!contract || !positive(spot) || !positive(contract.strike) || !positive(contract.impliedVolatility)) {
    return undefined;
  }
  return valueOption({
    ...DEFAULT_OPTION_CALC_DRAFT,
    side,
    spot,
    strike: contract.strike,
    daysToExpiry: daysToExpiryFrom(contract.expiration, now),
    volatility: contract.impliedVolatility,
    dividendYield: Number.isFinite(dividendYield) ? dividendYield! : 0,
  });
}
