import type { BrokerAccount } from "../../../types/trading";
import type { PortfolioSummaryTotals } from "./metrics";
import { portfolioPnlPercent } from "./position-metrics";

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
  return previousValue !== 0 ? (value / previousValue) * 100 : Number.NaN;
}

/**
 * Broker account figures are one-shot snapshots. Carry them forward by the
 * move current quotes show for the positions they price, so the header
 * follows the stream while staying anchored to the broker's own numbers.
 */
function snapshotDelta(totals: PortfolioSummaryTotals, side: "gross" | "net"): number {
  const delta = totals.brokerSnapshotDelta?.[side];
  return finiteNumber(delta) ? delta : 0;
}

/** With a current real-time quote for every position, quote totals replace the broker snapshot. */
function liveTotal(totals: PortfolioSummaryTotals, value: number): number | null {
  return totals.livePriced === true && Number.isFinite(value) ? value : null;
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
  const live = liveTotal(totals, totals.totalMktValue);
  if (live != null) return live;
  const broker = resolveBrokerPortfolioMarketValue(account, convertAccountValue);
  return broker != null ? broker + snapshotDelta(totals, "gross") : totals.totalMktValue;
}

/** Net liquidation moves with the positions; cash and margin stay as the broker reported them. */
export function resolvePortfolioNetLiquidation(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
): number | null {
  if (!finiteNumber(account?.netLiquidation)) return null;
  return convertAccountValue(account.netLiquidation) + snapshotDelta(totals, "net");
}

export function resolvePortfolioAccountMetrics(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
): PortfolioAccountMetrics {
  const liveDailyPnl = liveTotal(totals, totals.dailyPnl);
  const brokerDailyPnl = liveDailyPnl == null && finiteNumber(account?.dailyPnl) ? convertAccountValue(account.dailyPnl) : null;
  const dailyPnl = brokerDailyPnl != null ? brokerDailyPnl + snapshotDelta(totals, "net") : totals.dailyPnl;
  // The prior close does not move intraday, so the snapshot's own pair defines it.
  const previousNetLiquidation = brokerDailyPnl != null && finiteNumber(account?.netLiquidation)
    ? convertAccountValue(account.netLiquidation) - brokerDailyPnl
    : null;
  const dailyPnlPct = previousNetLiquidation != null
    ? percentChange(dailyPnl, previousNetLiquidation)
    : totals.dailyPnlPct;

  const liveUnrealizedPnl = liveTotal(totals, totals.unrealizedPnl);
  const brokerUnrealizedPnl = liveUnrealizedPnl == null && finiteNumber(account?.unrealizedPnl)
    ? convertAccountValue(account.unrealizedPnl) + snapshotDelta(totals, "net")
    : null;
  const unrealizedPnl = brokerUnrealizedPnl ?? totals.unrealizedPnl;
  const unrealizedPnlPct = portfolioPnlPercent(unrealizedPnl, totals.totalCostBasis) ?? Number.NaN;

  return {
    dailyPnl,
    dailyPnlPct,
    unrealizedPnl,
    unrealizedPnlPct,
    realizedPnl: finiteNumber(account?.realizedPnl) ? convertAccountValue(account.realizedPnl) : undefined,
  };
}
