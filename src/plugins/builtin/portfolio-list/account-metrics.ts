import type { BrokerAccount } from "../../../types/trading";
import type { PortfolioSummaryTotals } from "./metrics";

export interface PortfolioAccountMetrics {
  dailyPnl: number;
  dailyPnlPct: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl?: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentChange(value: number, previousValue: number): number {
  return previousValue !== 0 ? (value / previousValue) * 100 : 0;
}

export function resolveBrokerPortfolioMarketValue(
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
): number | null {
  if (finiteNumber(account?.grossPositionValue)) {
    return convertAccountValue(account.grossPositionValue);
  }
  return null;
}

export function resolvePortfolioMarketValue(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
): number {
  return resolveBrokerPortfolioMarketValue(account, convertAccountValue) ?? totals.totalMktValue;
}

export function resolvePortfolioAccountMetrics(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
): PortfolioAccountMetrics {
  const brokerDailyPnl = finiteNumber(account?.dailyPnl) ? convertAccountValue(account.dailyPnl) : null;
  const dailyPnl = brokerDailyPnl ?? totals.dailyPnl;
  const previousNetLiquidation = brokerDailyPnl != null && finiteNumber(account?.netLiquidation)
    ? convertAccountValue(account.netLiquidation) - dailyPnl
    : null;
  const dailyPnlPct = previousNetLiquidation != null
    ? percentChange(dailyPnl, previousNetLiquidation)
    : totals.dailyPnlPct;

  const brokerUnrealizedPnl = finiteNumber(account?.unrealizedPnl) ? convertAccountValue(account.unrealizedPnl) : null;
  const unrealizedPnl = brokerUnrealizedPnl ?? totals.unrealizedPnl;
  const unrealizedPnlPct = totals.totalCostBasis !== 0
    ? percentChange(unrealizedPnl, totals.totalCostBasis)
    : totals.unrealizedPnlPct;

  return {
    dailyPnl,
    dailyPnlPct,
    unrealizedPnl,
    unrealizedPnlPct,
    realizedPnl: finiteNumber(account?.realizedPnl) ? convertAccountValue(account.realizedPnl) : undefined,
  };
}
