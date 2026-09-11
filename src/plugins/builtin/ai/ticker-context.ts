import { convertCurrency, formatCompact, formatCompactCurrency, formatCurrency, formatPercent } from "../../../utils/format";
import { formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";

export function buildTickerAiContext(
  ticker: TickerRecord,
  financials: TickerFinancials | null,
  baseCurrency: string,
  exchangeRates: Map<string, number>,
): string {
  const metadata = ticker.metadata;
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const profile = financials?.profile;
  const quoteCurrency = quote?.currency ?? metadata.currency ?? baseCurrency;
  const toBase = (value: number, fromCurrency: string) =>
    convertCurrency(value, fromCurrency, baseCurrency, exchangeRates);
  const sector = metadata.sector ?? profile?.sector;
  const industry = metadata.industry ?? profile?.industry;

  const lines: string[] = [
    `Company: ${metadata.name} (${metadata.ticker})`,
    `Exchange: ${metadata.exchange}`,
  ];

  if (sector) lines.push(`Sector: ${sector}`);
  if (industry) lines.push(`Industry: ${industry}`);
  if (profile?.description) lines.push(`Description: ${profile.description}`);

  if (quote) {
    lines.push(`Current Price: ${formatMarketPriceWithCurrency(quote.price, quote.currency, { assetCategory: metadata.assetCategory })} (${quote.change >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%)`);
    if (quote.marketCap) lines.push(`Market Cap: ${formatCompactCurrency(toBase(quote.marketCap, quoteCurrency), baseCurrency)}`);
    if (quote.high52w && quote.low52w) lines.push(`52W Range: ${formatMarketPriceWithCurrency(quote.low52w, quote.currency, { assetCategory: metadata.assetCategory })} - ${formatMarketPriceWithCurrency(quote.high52w, quote.currency, { assetCategory: metadata.assetCategory })}`);
  }

  if (fundamentals) {
    if (fundamentals.trailingPE) lines.push(`P/E (TTM): ${fundamentals.trailingPE.toFixed(1)}`);
    if (fundamentals.forwardPE) lines.push(`Forward P/E: ${fundamentals.forwardPE.toFixed(1)}`);
    if (fundamentals.pegRatio) lines.push(`PEG: ${fundamentals.pegRatio.toFixed(2)}`);
    if (fundamentals.revenue) lines.push(`Revenue: ${formatCompact(fundamentals.revenue)}`);
    if (fundamentals.netIncome) lines.push(`Net Income: ${formatCompact(fundamentals.netIncome)}`);
    if (fundamentals.eps) lines.push(`EPS: ${formatCurrency(fundamentals.eps)}`);
    if (fundamentals.operatingMargin != null) lines.push(`Operating Margin: ${formatPercent(fundamentals.operatingMargin)}`);
    if (fundamentals.profitMargin != null) lines.push(`Profit Margin: ${formatPercent(fundamentals.profitMargin)}`);
    if (fundamentals.freeCashFlow) lines.push(`Free Cash Flow: ${formatCompact(fundamentals.freeCashFlow)}`);
    if (fundamentals.dividendYield != null) lines.push(`Dividend Yield${fundamentals.dividendYieldBasis ? ` (${fundamentals.dividendYieldBasis})` : ""}: ${formatPercent(fundamentals.dividendYield)}${fundamentals.dividendYieldSource ? ` [${fundamentals.dividendYieldSource}]` : ""}`);
    if (fundamentals.return1Y != null) lines.push(`1Y Return: ${formatPercent(fundamentals.return1Y)}`);
  }

  if (financials?.annualStatements && financials.annualStatements.length > 0) {
    const latest = financials.annualStatements[financials.annualStatements.length - 1]!;
    lines.push("");
    lines.push(`Latest Annual Statement (${latest.date}):`);
    if (latest.totalRevenue) lines.push(`  Revenue: ${formatCompact(latest.totalRevenue)}`);
    if (latest.netIncome) lines.push(`  Net Income: ${formatCompact(latest.netIncome)}`);
    if (latest.operatingCashFlow) lines.push(`  Operating CF: ${formatCompact(latest.operatingCashFlow)}`);
    if (latest.freeCashFlow) lines.push(`  Free Cash Flow: ${formatCompact(latest.freeCashFlow)}`);
    if (latest.totalAssets) lines.push(`  Total Assets: ${formatCompact(latest.totalAssets)}`);
    if (latest.totalDebt) lines.push(`  Total Debt: ${formatCompact(latest.totalDebt)}`);
    if (latest.totalEquity) lines.push(`  Equity: ${formatCompact(latest.totalEquity)}`);
  }

  return lines.join("\n");
}
