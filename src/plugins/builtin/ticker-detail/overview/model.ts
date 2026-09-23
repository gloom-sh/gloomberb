import { formatPriceEarnings } from "../../../../utils/price-earnings";
import { convertMarketCapitalization } from "../../../../utils/market-capitalization";
import { priceColor } from "../../../../theme/colors";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import {
  formatCompact,
  formatCompactCurrency,
  formatCurrency,
  formatNumber,
  formatLevelPercent,
  formatPercent,
  formatPercentRaw,
} from "../../../../utils/format";
import {
  formatMarketCostWithCurrency,
  formatMarketPriceWithCurrency,
  formatMarketQuantity,
  withCurrencyMinorDigits,
} from "../../../../market-data/market/format";
import type { PositionTableRow, StatField } from "./types";
import { getPortfolioPositionMetrics, getPortfolioQuoteDisplay, resolvePortfolioMarketValue, resolvePortfolioPositionPnl, portfolioPnlPercent, signedPositionDirection } from "../../portfolio-list/position-metrics";
import { liveDividendYield, liveForwardPE, liveMarketCapitalization, liveTrailingPE } from "../../portfolio-list/live-valuation";
import { formatReportedMoney } from "../../../../utils/reported-money";

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
  marketCapExchangeRates = new Map(),
}: {
  quote: Quote | undefined;
  fundamentals: TickerFinancials["fundamentals"] | undefined;
  quoteCurrency: string;
  baseCurrency: string;
  toBase: CurrencyConverter;
  marketCapExchangeRates?: ReadonlyMap<string, number>;
}): StatField[] {
  const stats: StatField[] = [];
  const money = (value: number, perShare = false) => formatReportedMoney(value, fundamentals?.financialCurrency, perShare);

  if (quote?.volume != null) {
    stats.push({ label: "Volume", value: formatCompact(quote.volume) });
  }
  // Price-derived statistics follow the quote; see live-valuation for when a stored figure is kept.
  const capitalization = liveMarketCapitalization(quote, fundamentals);
  if (capitalization) {
    const converted = convertMarketCapitalization(capitalization.value, capitalization.currency, baseCurrency, marketCapExchangeRates);
    stats.push({ label: "Market Cap", value: formatCompactCurrency(converted ?? capitalization.value, converted == null ? capitalization.currency : baseCurrency) });
  }
  if (fundamentals?.sharesOutstanding) {
    stats.push({ label: "Shares Out", value: formatCompact(fundamentals.sharesOutstanding) });
  }
  const trailingPE = liveTrailingPE(quote, fundamentals);
  if (trailingPE != null) {
    stats.push({ label: "P/E (TTM)", value: formatPriceEarnings(trailingPE) });
  }
  const forwardPE = liveForwardPE(quote, fundamentals);
  if (forwardPE != null) {
    stats.push({ label: "Fwd P/E", value: formatPriceEarnings(forwardPE) });
  }
  if (fundamentals?.eps != null) {
    stats.push({ label: "EPS", value: money(fundamentals.eps, true) });
  }
  if (fundamentals?.pegRatio != null) {
    stats.push({ label: "PEG", value: formatNumber(fundamentals.pegRatio, 2) });
  }
  const dividendYield = liveDividendYield(quote, fundamentals);
  if (fundamentals && dividendYield != null) {
    const label = fundamentals.dividendYieldBasis === "forward" ? "Fwd Div Yld" : fundamentals.dividendYieldBasis === "trailing" ? "TTM Div Yld" : "Div Yield";
    stats.push({ label, value: formatLevelPercent(dividendYield) });
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
    stats.push({ label: "Op Margin", value: formatLevelPercent(fundamentals.operatingMargin) });
  }
  if (fundamentals?.profitMargin != null) {
    stats.push({ label: "Profit Marg", value: formatLevelPercent(fundamentals.profitMargin) });
  }
  if (fundamentals?.revenueGrowth != null) {
    stats.push({
      label: "Rev Growth",
      value: formatPercent(fundamentals.revenueGrowth),
      valueColor: priceColor(fundamentals.revenueGrowth),
    });
  }
  if (fundamentals?.unavailableFields?.includes("enterpriseValue")) {
    stats.push({ label: "EV", value: "—" });
  } else if (fundamentals?.enterpriseValue != null) {
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
  return ticker.metadata.positions.filter((position) => position.shares !== 0).map((position) => {
    const positionCurrency = getPortfolioPositionMetrics(
      { ...ticker, metadata: { ...ticker.metadata, positions: [position] } }, undefined, quoteCurrency, undefined, quote,
    ).positionCurrency;
    const metrics = getPortfolioPositionMetrics(
      { ...ticker, metadata: { ...ticker.metadata, positions: [position] } },
      undefined,
      quoteCurrency,
      { currency: baseCurrency, convert: toBase },
      quote,
    );
    const activeQuote = getPortfolioQuoteDisplay(metrics, quote);
    const currentPrice = activeQuote?.price ?? null;
    const finiteValue = (value: number | null): number | null => value != null && Number.isFinite(value) ? value : null;
    const costBasisBase = finiteValue(metrics.totalCost);
    const hasBrokerMark = metrics.brokerMarkPrice != null && Number.isFinite(metrics.brokerMarkPrice);
    const fallbackMarkPrice = currentPrice ?? (hasBrokerMark ? position.markPrice : undefined);
    const fallbackMarkCurrency = currentPrice != null ? quoteCurrency : positionCurrency;
    const marketValueBase = resolvePortfolioMarketValue(metrics, currentPrice != null ? toBase(currentPrice, quoteCurrency) : null)?.gross ?? null;
    const selectedPnl = resolvePortfolioPositionPnl(metrics,
      currentPrice != null ? toBase(currentPrice, quoteCurrency) : null);
    const pnlValue = selectedPnl.value;
    const percent = portfolioPnlPercent(pnlValue, costBasisBase != null ? Math.abs(costBasisBase) : Number.NaN);
    const returnPercent = percent === null ? "—" : formatPercentRaw(percent);
    const unit = metrics.priceBasis === "percent-of-par" ? "" : ticker.metadata.assetCategory === "BOND" ? " units" : metrics.multiplierHint > 1 ? " ct" : " sh";

    return {
      account: compactPositionAccount(position),
      qty: `${formatMarketQuantity(metrics.totalShares, { assetCategory: ticker.metadata.assetCategory, multiplier: position.multiplier, priceBasis: metrics.priceBasis, quantityCurrency: positionCurrency, maxWidth: metrics.priceBasis === "percent-of-par" ? 11 : undefined })}${unit}`,
      quantityUnit: metrics.priceBasis === "percent-of-par" ? "face" : undefined,
      // Avg and Mark sit side by side, so both keep the currency's minor unit ($118.40 beside $224.36).
      avg: formatMarketCostWithCurrency(position.avgCost, positionCurrency, withCurrencyMinorDigits({
        assetCategory: ticker.metadata.assetCategory,
        multiplier: position.multiplier,
        priceBasis: metrics.priceBasis,
        maxWidth: 9,
      }, positionCurrency)),
      mark: fallbackMarkPrice != null && Number.isFinite(fallbackMarkPrice)
        ? formatMarketPriceWithCurrency(fallbackMarkPrice, fallbackMarkCurrency, withCurrencyMinorDigits({
            assetCategory: ticker.metadata.assetCategory,
            multiplier: position.multiplier,
            priceBasis: currentPrice != null ? quote?.priceBasis : metrics.priceBasis,
            maxWidth: 9,
          }, fallbackMarkCurrency))
        : "—",
      cost: costBasisBase != null ? formatCurrency(costBasisBase, baseCurrency) : "—",
      value: marketValueBase != null ? formatCurrency(marketValueBase, baseCurrency) : "—",
      pnl: pnlValue != null ? `${pnlValue >= 0 ? "+" : ""}${formatCurrency(pnlValue, baseCurrency)}` : "—",
      ret: returnPercent,
      pnlValue,
      pnlBasis: selectedPnl.basis,
    };
  });
}
