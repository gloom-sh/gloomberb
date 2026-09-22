import type { PriceHistoryIntegrity } from "../../../utils/price-history-integrity";
import type { OptionContract, OptionsChain, PricePoint } from "../../../types/financials";
import { realizedVolatilityResult } from "../shared/volatility";
import {
  DEFAULT_OPTION_CALC_DRAFT,
  daysToExpiryFrom,
  valueOption,
  type OptionSide,
  type OptionValuation,
} from "../options-calculator/model";

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

function historicalVolatilityResult(points: readonly PricePoint[]): HistoricalVolatilityResult {
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
    expirationVolume: callVolume != null && putVolume != null ? callVolume + putVolume : null,
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
