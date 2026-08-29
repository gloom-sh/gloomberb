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

/** Annualized standard deviation of the latest 30 daily log returns. */
export function historicalVolatility30d(points: readonly PricePoint[]): number | null {
  const closes = points
    .map((point) => ({
      close: point.close,
      time: point.date instanceof Date ? point.date.getTime() : Date.parse(String(point.date)),
    }))
    .filter((point) => positive(point.close) && Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time)
    .slice(-(HISTORICAL_VOLATILITY_SESSIONS + 1))
    .map((point) => point.close);
  if (closes.length < HISTORICAL_VOLATILITY_SESSIONS + 1) return null;

  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]!));
  const mean = returns.reduce((total, value) => total + value, 0) / returns.length;
  const variance = returns.reduce((total, value) => total + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
}

export function calculateOptionsSummary(
  chain: OptionsChain,
  spot: number | undefined,
  priceHistory: readonly PricePoint[],
): OptionsSummary {
  const atmIv = atmImpliedVolatility(chain, spot);
  const historicalVolatility = historicalVolatility30d(priceHistory);
  const callVolume = sum(chain.calls, "volume");
  const putVolume = sum(chain.puts, "volume");
  const callOpenInterest = sum(chain.calls, "openInterest");
  const putOpenInterest = sum(chain.puts, "openInterest");

  return {
    atmImpliedVolatility: atmIv,
    historicalVolatility30d: historicalVolatility,
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
