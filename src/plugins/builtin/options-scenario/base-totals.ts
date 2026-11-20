import { createBaseConverter } from "../../../cli/base-converter";
import type { DataProvider } from "../../../types/data-provider";
import { UNKNOWN_CURRENCY, type ScenarioModel, type ScenarioPosition } from "./model";

export function scenarioNeedsFx(currency: string | undefined, base: string): currency is string {
  return !!currency && currency !== UNKNOWN_CURRENCY && currency !== base;
}

export async function loadScenarioFx(provider: DataProvider, currency: string, base: string) {
  const convert = createBaseConverter(provider, base);
  const factor = await convert(1, currency);
  return Number.isFinite(factor) ? { currency, base, factor, mark: convert.conversions()[0] ?? null } : null;
}

export function netPremiumTotal(position: ScenarioPosition): number {
  return position.legs.reduce((total, leg) => total - leg.price * leg.quantity * leg.multiplier, 0);
}

export function scenarioMoneyTotals(scenario: ScenarioModel) {
  return [
    { key: "netPremiumTotal", label: "Net premium total", value: netPremiumTotal(scenario.position), unlimited: false },
    { key: "value", label: "Value", value: scenario.valuation.price, unlimited: false },
    { key: "pnl", label: "P&L", value: scenario.valuation.pnl, unlimited: false },
    { key: "maxProfit", label: "Max profit", value: scenario.expiryRisk.maxProfit, unlimited: scenario.expiryRisk.unlimitedProfit },
    { key: "maxLoss", label: "Max loss", value: scenario.expiryRisk.maxLoss, unlimited: scenario.expiryRisk.unlimitedLoss },
  ];
}
