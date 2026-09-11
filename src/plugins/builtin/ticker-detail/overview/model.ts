import { priceColor } from "../../../../theme/colors";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import {
  formatCompact,
  formatCompactCurrency,
  formatCurrency,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../../../utils/format";
import {
  formatMarketCostWithCurrency,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
} from "../../../../market-data/market/format";
import type { PositionTableRow, StatField } from "./types";
import { getPortfolioPositionMetrics, signedPositionDirection } from "../../portfolio-list/position-metrics";

type CurrencyConverter = (value: number, fromCurrency: string) => number;

function compactPositionAccount(position: TickerPosition): string {
  const rawAccount = position.brokerAccountId || position.portfolio;
  const isBrokerPortfolio = rawAccount.startsWith("broker:");
  const account = isBrokerPortfolio
    ? rawAccount.split(":").filter(Boolean).at(-1) || rawAccount
    : rawAccount;
  const prefix = !isBrokerPortfolio && position.broker && position.broker !== "manual" ? `${position.broker} ` : "";
  const suffix = signedPositionDirection(position) < 0 ? " SHORT" : "";
  return `${prefix}${account}${suffix}`;
}

export function buildOverviewStats({
  quote,
  fundamentals,
  quoteCurrency,
  baseCurrency,
  toBase,
}: {
  quote: Quote | undefined;
  fundamentals: TickerFinancials["fundamentals"] | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
}): StatField[] {
  const stats: StatField[] = [];
  const financialCurrency = fundamentals?.financialCurrency;
  const money = (value: number) => financialCurrency
    ? formatCompactCurrency(value, financialCurrency)
    : formatCompact(value);

  if (quote?.volume != null) {
    stats.push({ label: "Volume", value: formatCompact(quote.volume) });
  }
  if (quote?.marketCap) {
    stats.push({ label: "Market Cap", value: formatCompactCurrency(toBase(quote.marketCap, quoteCurrency), baseCurrency) });
  }
  if (fundamentals?.sharesOutstanding) {
    stats.push({ label: "Shares Out", value: formatCompact(fundamentals.sharesOutstanding) });
  }
  if (fundamentals?.trailingPE != null) {
    stats.push({ label: "P/E (TTM)", value: formatNumber(fundamentals.trailingPE, 1) });
  }
  if (fundamentals?.forwardPE != null) {
    stats.push({ label: "Fwd P/E", value: formatNumber(fundamentals.forwardPE, 1) });
  }
  if (fundamentals?.eps != null) {
    stats.push({ label: "EPS", value: financialCurrency ? formatCurrency(fundamentals.eps, financialCurrency) : formatNumber(fundamentals.eps, 2) });
  }
  if (fundamentals?.pegRatio != null) {
    stats.push({ label: "PEG", value: formatNumber(fundamentals.pegRatio, 2) });
  }
  if (fundamentals?.dividendYield != null) {
    stats.push({ label: "Div Yield", value: formatPercent(fundamentals.dividendYield) });
  }
  if (fundamentals?.revenue != null) {
    stats.push({ label: "Revenue", value: money(fundamentals.revenue) });
  }
  if (fundamentals?.netIncome != null) {
    stats.push({ label: "Net Income", value: money(fundamentals.netIncome) });
  }
  if (fundamentals?.freeCashFlow != null) {
    stats.push({ label: "FCF", value: money(fundamentals.freeCashFlow) });
  }
  if (fundamentals?.operatingMargin != null) {
    stats.push({ label: "Op Margin", value: formatPercent(fundamentals.operatingMargin) });
  }
  if (fundamentals?.profitMargin != null) {
    stats.push({ label: "Profit Marg", value: formatPercent(fundamentals.profitMargin) });
  }
  if (fundamentals?.revenueGrowth != null) {
    stats.push({
      label: "Rev Growth",
      value: formatPercent(fundamentals.revenueGrowth),
      valueColor: priceColor(fundamentals.revenueGrowth),
    });
  }
  if (fundamentals?.enterpriseValue != null) {
    stats.push({ label: "EV", value: formatCompactCurrency(fundamentals.enterpriseValue, quoteCurrency) });
  }

  return stats;
}

export function buildPositionRows({
  ticker,
  quote,
  quoteCurrency,
  baseCurrency,
  toBase,
}: {
  ticker: TickerRecord;
  quote: Quote | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
}): PositionTableRow[] {
  return ticker.metadata.positions.map((position) => {
    const positionCurrency = position.currency || quoteCurrency;
    const metrics = getPortfolioPositionMetrics(
      { ...ticker, metadata: { ...ticker.metadata, positions: [position] } },
      undefined,
      quoteCurrency,
      { currency: baseCurrency, convert: toBase },
    );
    const finiteValue = (value: number | null): number | null => value != null && Number.isFinite(value) ? value : null;
    const costBasisBase = finiteValue(metrics.totalCost);
    const hasBrokerMark = Number.isFinite(position.markPrice);
    const fallbackMarkPrice = hasBrokerMark ? position.markPrice : quote?.price;
    const fallbackMarkCurrency = hasBrokerMark ? positionCurrency : quoteCurrency;
    const marketValueBase = finiteValue(metrics.hasBrokerMktValue
      ? metrics.brokerMktValue
      : Number.isFinite(quote?.price)
        ? toBase(metrics.grossPriceUnits * quote!.price, quoteCurrency)
        : null);
    const pnlValue = finiteValue(metrics.hasBrokerPnl
      ? metrics.brokerPnl
      : marketValueBase != null
        ? signedPositionDirection(position) * marketValueBase - metrics.signedCost
        : null);
    const returnPercent = pnlValue != null && costBasisBase != null && costBasisBase !== 0
      ? formatPercentRaw((pnlValue / costBasisBase) * 100)
      : "—";
    const unit = metrics.multiplierHint > 1 ? " ct" : " sh";

    return {
      account: compactPositionAccount(position),
      qty: `${formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier })}${unit}`,
      avg: formatMarketCostWithCurrency(position.avgCost, positionCurrency, {
        assetCategory: ticker.metadata.assetCategory,
        multiplier: position.multiplier,
      }),
      mark: fallbackMarkPrice != null && Number.isFinite(fallbackMarkPrice)
        ? formatMarketPriceWithCurrency(fallbackMarkPrice, fallbackMarkCurrency, {
            assetCategory: ticker.metadata.assetCategory,
            multiplier: position.multiplier,
          })
        : "—",
      cost: costBasisBase != null ? formatCurrency(costBasisBase, baseCurrency) : "—",
      value: marketValueBase != null ? formatCurrency(marketValueBase, baseCurrency) : "—",
      pnl: pnlValue != null ? `${pnlValue >= 0 ? "+" : ""}${formatCurrency(pnlValue, baseCurrency)}` : "—",
      ret: returnPercent,
      pnlValue,
    };
  });
}
