import { resolveChartPalette } from "../../../components/chart/core/palette";
import { colors, priceColor } from "../../../theme/colors";
import type { TickerFinancials, PricePoint } from "../../../types/financials";
import type { BrokerAccount, BrokerPortfolioPerformance } from "../../../types/trading";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";
import { formatRelativeAge } from "../../../utils/relative-time";
import { instrumentFromTicker, type ChartRequest } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import { resolvePortfolioAccountMetrics, resolvePortfolioMarketValue } from "../portfolio-list/account-metrics";
import type { ColumnContext, PortfolioSummaryTotals } from "../portfolio-list/metrics";
import type { ResolvedPortfolioAccountState } from "../portfolio-list/summary";
import { buildPerformanceChartPoints, resolvePerformanceMetric } from "./broker-performance";
import {
  formatReturn,
  formatSignedCompact,
} from "./display";
import {
  computeDatedReturns,
  computeWeightedPortfolioReturns,
  syntheticAccountUnsupportedReason,
  syntheticPositionUnsupportedReason,
  type DatedReturn,
  type WeightedReturnSeries,
} from "./metrics";
import { getPortfolioPositionValue } from "./sector-model";
import type { AnalyticsMetricRow } from "./view";

export interface PortfolioChartTarget {
  ticker: TickerRecord;
  request: ChartRequest;
}

export type ChartEntryLookup = Map<string, {
  data?: PricePoint[] | null;
  lastGoodData?: PricePoint[] | null;
} | undefined>;

function formatIsoDateMonthDay(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatAccountFreshness(account: ResolvedPortfolioAccountState["account"] | undefined): string | null {
  if (!account) return null;
  if (account.asOfDate) return formatIsoDateMonthDay(account.asOfDate);
  return account.updatedAt ? formatRelativeAge(account.updatedAt) : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMarginLeverage(netLiquidation: number | undefined, totalMarketValue: number): string | null {
  if (!finiteNumber(netLiquidation) || netLiquidation <= 0 || !finiteNumber(totalMarketValue) || totalMarketValue < 0) return null;
  return `${(totalMarketValue / netLiquidation).toFixed(1)}x`;
}

export function buildPortfolioChartTargets(portfolioTickers: TickerRecord[]): PortfolioChartTarget[] {
  return portfolioTickers.flatMap((ticker) => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker);
    if (!instrument) return [];
    return [{
      ticker,
      request: {
        instrument,
        bufferRange: "1Y" as const,
        granularity: "range" as const,
      },
    }];
  });
}

export interface PortfolioReturnSeriesResult {
  returns: DatedReturn[] | null;
  /** Share of portfolio value whose history actually made it into the weighted series, 0..1. */
  coverage: number;
  /** Holdings dropped because their history was missing, still loading, or too short. */
  missingCount: number;
  /** Holdings with no reliable base-currency value, so weights cannot be determined. */
  unvaluedCount: number;
  unsupportedReason: string | null;
}

export function buildPortfolioReturnSeries({
  chartTargets,
  chartEntries,
  financials,
  columnContext,
  account,
}: {
  chartTargets: PortfolioChartTarget[];
  chartEntries: ChartEntryLookup;
  financials: Map<string, TickerFinancials>;
  columnContext: ColumnContext;
  account?: BrokerAccount | null;
}): PortfolioReturnSeriesResult {
  const weightedSeries: WeightedReturnSeries[] = [];
  let coveredValue = 0;
  let totalValue = 0;
  let missingCount = 0;
  let unvaluedCount = 0;
  let unsupportedReason = syntheticAccountUnsupportedReason(account);
  for (const { ticker, request } of chartTargets) {
    unsupportedReason ??= syntheticPositionUnsupportedReason(
      ticker,
      financials.get(ticker.metadata.ticker)?.quote?.currency || ticker.metadata.currency || columnContext.baseCurrency,
      columnContext.activeTab,
    );
    const value = getPortfolioPositionValue(ticker, financials.get(ticker.metadata.ticker), columnContext);
    if (value == null) unvaluedCount += 1;
    const weight = value == null ? 0 : Math.abs(value);
    totalValue += weight;

    const key = buildChartKey(request);
    const entry = chartEntries.get(key);
    const history = entry?.data ?? entry?.lastGoodData ?? null;
    const returns = history && history.length >= 11 ? computeDatedReturns(history) : [];
    if (value == null || returns.length < 10) {
      missingCount += 1;
      continue;
    }

    coveredValue += weight;
    weightedSeries.push({ weight: value, returns });
  }

  const returns = computeWeightedPortfolioReturns(weightedSeries);
  return {
    returns: !unsupportedReason && unvaluedCount === 0 && returns.length > 0 ? returns : null,
    coverage: totalValue > 0 ? coveredValue / totalValue : chartTargets.length === 0 ? 1 : 0,
    missingCount,
    unvaluedCount,
    unsupportedReason,
  };
}

export function buildBenchmarkReturnSeries(
  request: ChartRequest,
  chartEntries: ChartEntryLookup,
): DatedReturn[] | null {
  const entry = chartEntries.get(buildChartKey(request));
  const history = entry?.data ?? entry?.lastGoodData ?? null;
  if (!history || history.length < 11) return null;
  const returns = computeDatedReturns(history);
  return returns.length > 0 ? returns : null;
}

export function buildAnalyticsSummaryRows({
  accountState,
  brokerPerformance,
  portfolioStats,
  convertAccountValue = (value) => value,
}: {
  accountState: ResolvedPortfolioAccountState | null;
  activePortfolio: Portfolio | null;
  brokerPerformance: BrokerPortfolioPerformance | null;
  portfolioStats: PortfolioSummaryTotals;
  convertAccountValue?: (value: number) => number;
}): AnalyticsMetricRow[] {
  const rows: AnalyticsMetricRow[] = [];
  const account = accountState?.account;
  const accountMetrics = resolvePortfolioAccountMetrics(portfolioStats, account, convertAccountValue);
  const accountFreshness = formatAccountFreshness(account);
  const totalMarketValue = resolvePortfolioMarketValue(portfolioStats, account, convertAccountValue);

  if (portfolioStats.unavailableConversions?.length || (account && !Number.isFinite(convertAccountValue(1)))) {
    rows.push({
      id: "fx-unavailable", label: "FX", value: "Unavailable",
      detail: portfolioStats.unavailableConversions?.join(", ") ?? account?.currency,
      color: colors.warning,
    });
  }

  if (account?.netLiquidation != null) {
    rows.push({
      id: "net-liquidation",
      label: "Net Liq",
      value: formatCompact(convertAccountValue(account.netLiquidation)),
      color: colors.text,
    });
  }

  rows.push({
    id: "total-value",
    label: "Val",
    value: formatCompact(totalMarketValue),
    color: colors.text,
  });

  const marginLeverage = formatMarginLeverage(
    account?.netLiquidation == null ? undefined : convertAccountValue(account.netLiquidation),
    totalMarketValue,
  );
  if (marginLeverage) {
    rows.push({
      id: "margin-leverage",
      label: "Margin Lev",
      value: marginLeverage,
      color: colors.text,
    });
  }

  if (account?.totalCashValue != null) {
    rows.push({
      id: "cash",
      label: "Cash",
      value: formatCompact(convertAccountValue(account.totalCashValue)),
      color: colors.text,
    });
  }

  rows.push({
    id: "day-pnl",
    label: "Day",
    value: formatSignedCompact(accountMetrics.dailyPnl),
    detail: `(${formatPercentRaw(accountMetrics.dailyPnlPct)})`,
    color: priceColor(accountMetrics.dailyPnl),
  });
  rows.push({
    id: "pnl",
    label: "P&L",
    value: formatSignedCompact(accountMetrics.unrealizedPnl),
    detail: `(${formatPercentRaw(accountMetrics.unrealizedPnlPct)})`,
    color: priceColor(accountMetrics.unrealizedPnl),
  });
  if (accountMetrics.realizedPnl != null) {
    rows.push({
      id: "realized-pnl",
      label: "Realized",
      value: formatSignedCompact(accountMetrics.realizedPnl),
      color: priceColor(accountMetrics.realizedPnl),
    });
  }

  const latestPerformancePoint = brokerPerformance?.points
    .filter((point) => Number.isFinite(new Date(point.date).getTime()))
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime()).at(-1);
  if (latestPerformancePoint?.cumulativeReturn != null && Number.isFinite(latestPerformancePoint.cumulativeReturn)) {
    rows.push({
      id: "historical-return",
      label: "Broker return",
      value: formatReturn(latestPerformancePoint.cumulativeReturn),
      detail: brokerPerformance?.period,
      color: priceColor(latestPerformancePoint.cumulativeReturn),
    });
  }

  if (account?.settledCash != null) {
    rows.push({
      id: "settled-cash",
      label: "Settled",
      value: formatCompact(convertAccountValue(account.settledCash)),
      color: colors.text,
    });
  }
  if (account?.availableFunds != null) {
    rows.push({
      id: "available-funds",
      label: "Avail",
      value: formatCompact(convertAccountValue(account.availableFunds)),
      color: colors.text,
    });
  }
  if (account?.excessLiquidity != null) {
    rows.push({
      id: "excess-liquidity",
      label: "Excess",
      value: formatCompact(convertAccountValue(account.excessLiquidity)),
      color: colors.text,
    });
  }
  if (account?.buyingPower != null) {
    rows.push({
      id: "buying-power",
      label: "BP",
      value: formatCompact(convertAccountValue(account.buyingPower)),
      color: colors.text,
    });
  }
  if (accountState) {
    if (accountFreshness) {
      rows.push({
        id: "account-freshness",
        label: "As Of",
        value: accountFreshness,
        color: colors.textDim,
      });
    }
    rows.push({
      id: "account-source",
      label: "Source",
      value: accountState.sourceLabel,
      color: colors.textDim,
    });
  }

  return rows;
}

/**
 * Names the slice of the portfolio the risk numbers actually describe, so a
 * Sharpe built on half the book is never presented as the whole book.
 */
export function formatRiskCoverage(coverage: number, missingCount: number): string | null {
  if (missingCount <= 0 || coverage >= 0.999) return null;
  return `${formatPercentRaw(coverage * 100)} of value, ${missingCount} holding${missingCount === 1 ? "" : "s"} pending`;
}

export function buildAnalyticsRiskRows({
  sharpe,
  beta,
  coverage = 1,
  missingCount = 0,
  unvaluedCount = 0,
  unsupportedReason = null,
}: {
  sharpe: number | null;
  beta: number | null;
  coverage?: number;
  missingCount?: number;
  unvaluedCount?: number;
  unsupportedReason?: string | null;
}): AnalyticsMetricRow[] {
  const unavailable = unvaluedCount > 0
    ? `${unvaluedCount} holding${unvaluedCount === 1 ? "" : "s"} unvalued; check prices and FX`
    : unsupportedReason;
  const partial = formatRiskCoverage(coverage, missingCount);
  return [
    { id: "sharpe", label: "Est. Sharpe", value: sharpe, method: "Current weights; price returns; 5% Rf, 252 sessions" },
    { id: "beta", label: "Est. Beta (SPY)", value: beta, method: "Current weights; excludes cash, fees and trades" },
  ].map((row) => ({
    id: row.id,
    label: row.label,
    value: unavailable ? "—" : formatNumber(row.value ?? undefined, 2),
    detail: unavailable ?? (row.value == null ? "Insufficient history for basket estimate" : `${row.method}${partial ? `; partial: ${partial}` : ""}`),
    color: colors.textMuted,
  }));
}

export function resolvePerformancePalette(
  performance: BrokerPortfolioPerformance | null,
): ReturnType<typeof resolveChartPalette> {
  const points = buildPerformanceChartPoints(performance);
  const firstValue = points[0]?.close ?? null;
  const lastValue = points.at(-1)?.close ?? null;
  return resolveChartPalette(colors, firstValue != null && lastValue != null && lastValue < firstValue ? "negative" : "positive");
}

export function buildHistoryAxisLabel({
  performance,
  activePortfolio,
  baseCurrency,
}: {
  performance: BrokerPortfolioPerformance | null;
  activePortfolio: Portfolio | null;
  baseCurrency: string;
}): string {
  return resolvePerformanceMetric(performance) === "value"
    ? `Value (${performance?.currency ?? activePortfolio?.currency ?? baseCurrency})`
    : "Return";
}

export function formatHistoryAxisValue(
  value: number,
  performance: BrokerPortfolioPerformance | null,
): string {
  return resolvePerformanceMetric(performance) === "value"
    ? formatCompact(value)
    : `${(value * 100).toFixed(1)}%`;
}
