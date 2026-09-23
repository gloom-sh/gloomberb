import type { OptionsChain } from "../../../types/financials";
import { DEFAULT_OPTION_CALC_DRAFT, solveImpliedVolatility } from "../options-calculator/model";
import { optionExpirationClose, validatePosition, type ScenarioLeg, type ScenarioPosition } from "./model";

const DAY_MS = 86_400_000;

/**
 * The listed contract a leg describes: the chain's own symbol when the loaded
 * expiry lists it, otherwise the standard OCC form of the underlying root.
 * An edited leg always resolves from its current terms.
 */
export function scenarioLegContractSymbol(underlying: string, leg: ScenarioLeg, chain?: OptionsChain | null): string | null {
  const listed = (leg.side === "call" ? chain?.calls : chain?.puts)?.find((contract) =>
    contract.expiration === leg.expiration && Math.abs(contract.strike - leg.strike) < 1e-9);
  if (listed?.contractSymbol) return listed.contractSymbol.trim().toUpperCase();
  const root = underlying.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const date = new Date(leg.expiration * 1000);
  const strike = Math.round(leg.strike * 1000);
  if (!root || !Number.isFinite(date.getTime()) || !(strike > 0) || strike >= 1e8) return null;
  const yymmdd = date.toISOString().slice(2, 10).replaceAll("-", "");
  return `${root}${yymmdd}${leg.side === "call" ? "C" : "P"}${String(strike).padStart(8, "0")}`;
}

/**
 * The position marked to the market now: the live spot, the valuation origin
 * moved to the present, and each quoted leg's volatility solved from its live
 * midpoint on the pricer the scenario itself uses, so the leg's value now is
 * its midpoint. Entry prices, quantities and unquoted legs are untouched. An
 * origin that would leave a leg expired stays where it was.
 */
export function liveScenarioPosition(
  position: ScenarioPosition,
  spot: number,
  now: number,
  legMids: ReadonlyMap<string, number>,
): ScenarioPosition {
  const at = (asOf: number): ScenarioPosition => ({ ...position, spot, asOf, legs: position.legs.map((leg) => {
    const mid = legMids.get(leg.id);
    if (mid == null || !(mid > 0)) return leg;
    const volatility = solveImpliedVolatility({ ...DEFAULT_OPTION_CALC_DRAFT, side: leg.side, spot, strike: leg.strike,
      daysToExpiry: Math.max(0, (optionExpirationClose(leg.expiration) - asOf) / DAY_MS),
      rate: position.rate, dividendYield: position.dividendYield }, mid).volatility;
    return volatility != null && Number.isFinite(volatility) && volatility >= 0 ? { ...leg, volatility } : leg;
  }) });
  for (const asOf of [Math.max(position.asOf, now), position.asOf]) {
    const candidate = at(asOf);
    if (!validatePosition(candidate)) return candidate;
  }
  return position;
}
