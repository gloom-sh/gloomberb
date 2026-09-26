import type { BrokerAccount } from "../../../types/trading";
import { isTimestampStaleForExchangeSession } from "../../../market-data/market/freshness";
import type { PortfolioSummaryTotals } from "./metrics";
import { portfolioPnlPercent } from "./position-metrics";

export interface PortfolioAccountMetrics {
  dailyPnl: number;
  dailyPnlPct: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl?: number;
}

/**
 * When a broker account snapshot was taken, relative to the position marks.
 * - "marks": in the same import as the positions (a statement or a sync).
 *   The snapshot priced every lot at its broker mark, so a lot has since
 *   moved by its quote value minus that mark.
 * - "loaded": later, listed on connect or reloaded live. The snapshot already
 *   holds every move up to then, so a lot moves from the quote value first
 *   seen with the snapshot. The default: it can miss a move but never counts
 *   one twice.
 */
export type BrokerSnapshotBasis = "marks" | "loaded";

/**
 * Quote values first seen with each loaded snapshot, by lot, in the account's
 * currency. A reload is a new object and starts over.
 */
const loadedSnapshotBaselines = new WeakMap<BrokerAccount, Map<string, number>>();

interface SnapshotDelta {
  /** Applies to market value. */
  gross: number;
  /** Signed by side; applies to P&L and net liquidation. */
  net: number;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentChange(value: number, previousValue: number): number {
  return previousValue !== 0 ? (value / previousValue) * 100 : Number.NaN;
}

/**
 * Broker account figures are one-shot snapshots. Carry them forward by the
 * move current quotes show since the snapshot, so the header follows the
 * stream while staying anchored to the broker's own numbers.
 *
 * The snapshot is in the account's currency and is converted at the current
 * rate, which already moves every holding with FX. A loaded snapshot's
 * baselines are therefore kept in the account's currency and converted at the
 * same current rate, so only the quotes move the figure, never the FX rate twice.
 */
function brokerSnapshotDelta(
  totals: PortfolioSummaryTotals,
  account: BrokerAccount,
  basis: BrokerSnapshotBasis,
  convertAccountValue: (value: number) => number,
): SnapshotDelta {
  const delta = { gross: 0, net: 0 };
  const lots = totals.pricedLots;
  if (!lots?.length) return delta;
  if (basis === "marks") {
    // The marks and the quotes are both converted at the current rate.
    for (const lot of lots) {
      if (lot.brokerValue === null) continue;
      const move = lot.value - lot.brokerValue;
      delta.gross += move;
      delta.net += lot.direction * move;
    }
    return delta;
  }
  // Base currency per unit of the account's currency; conversion is linear.
  const accountRate = convertAccountValue(1);
  // Without the rate the account figures are unavailable, and a baseline taken now would be wrong later.
  if (!Number.isFinite(accountRate) || accountRate <= 0) return delta;
  let baselines = loadedSnapshotBaselines.get(account);
  if (!baselines) {
    baselines = new Map();
    loadedSnapshotBaselines.set(account, baselines);
  }
  for (const lot of lots) {
    let baseline = baselines.get(lot.key);
    if (baseline === undefined) {
      baseline = lot.value / accountRate;
      baselines.set(lot.key, baseline);
    }
    const move = lot.value - baseline * accountRate;
    delta.gross += move;
    delta.net += lot.direction * move;
  }
  return delta;
}

/** A broker's day P&L belongs to the session it was taken in. */
function isCurrentSessionSnapshot(account: BrokerAccount, now = Date.now()): boolean {
  const takenAt = account.dailyPnlAsOf ?? account.updatedAt;
  if (!finiteNumber(takenAt) || takenAt <= 0) return true;
  return !isTimestampStaleForExchangeSession(takenAt, "NYSE", now);
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
  basis: BrokerSnapshotBasis = "loaded",
): number {
  const live = liveTotal(totals, totals.totalMktValue);
  if (live != null) return live;
  const broker = resolveBrokerPortfolioMarketValue(account, convertAccountValue);
  return broker != null && account
    ? broker + brokerSnapshotDelta(totals, account, basis, convertAccountValue).gross
    : totals.totalMktValue;
}

/** Net liquidation moves with the positions; cash and margin stay as the broker reported them. */
export function resolvePortfolioNetLiquidation(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
  basis: BrokerSnapshotBasis = "loaded",
): number | null {
  if (!account || !finiteNumber(account.netLiquidation)) return null;
  return convertAccountValue(account.netLiquidation) + brokerSnapshotDelta(totals, account, basis, convertAccountValue).net;
}

export function resolvePortfolioAccountMetrics(
  totals: PortfolioSummaryTotals,
  account?: BrokerAccount | null,
  convertAccountValue: (value: number) => number = (value) => value,
  basis: BrokerSnapshotBasis = "loaded",
): PortfolioAccountMetrics {
  const delta = account ? brokerSnapshotDelta(totals, account, basis, convertAccountValue) : { gross: 0, net: 0 };

  // The broker's day P&L includes trades closed today, lots opened at their
  // fill and fees, which quotes cannot see. It stays the anchor while it is
  // from this session, so the figure and its basis never flip. One from an
  // earlier session only stands in, unmoved, when quotes cannot give today's.
  const currentSession = !!account && isCurrentSessionSnapshot(account);
  const brokerDailyPnl = account && finiteNumber(account.dailyPnl) && (currentSession || !Number.isFinite(totals.dailyPnl))
    ? convertAccountValue(account.dailyPnl)
    : null;
  const dailyPnl = brokerDailyPnl != null
    ? brokerDailyPnl + (currentSession ? delta.net : 0)
    : totals.dailyPnl;
  // The prior close does not move intraday. A broker that reports it directly
  // is used as is; otherwise the snapshot's own pair defines it.
  const previousNetLiquidation = brokerDailyPnl == null
    ? null
    : finiteNumber(account?.previousNetLiquidation)
      ? convertAccountValue(account.previousNetLiquidation)
      : finiteNumber(account?.netLiquidation)
        ? convertAccountValue(account.netLiquidation) - brokerDailyPnl
        : null;
  const dailyPnlPct = previousNetLiquidation != null
    ? percentChange(dailyPnl, previousNetLiquidation)
    : totals.dailyPnlPct;

  const liveUnrealizedPnl = liveTotal(totals, totals.unrealizedPnl);
  const brokerUnrealizedPnl = liveUnrealizedPnl == null && finiteNumber(account?.unrealizedPnl)
    ? convertAccountValue(account.unrealizedPnl) + delta.net
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
