import type { TickerFinancials } from "../../../types/financials";

export function relativeValuationValues(financials: TickerFinancials | null) {
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const compatibleCurrency = !!fundamentals?.financialCurrency && !!quote?.currency
    && fundamentals.financialCurrency === quote.currency;
  return {
    price: quote?.price ?? null,
    currency: quote?.currency ?? null,
    changePercent: quote?.changePercent ?? null,
    marketCap: quote?.marketCap ?? null,
    trailingPE: fundamentals?.trailingPE ?? null,
    forwardPE: fundamentals?.forwardPE ?? null,
    // Vendor ADR ratios can mix unverified valuation and reporting units too.
    evSales: !compatibleCurrency ? null
      : fundamentals?.enterpriseToRevenue != null && Number.isFinite(fundamentals.enterpriseToRevenue)
        ? fundamentals.enterpriseToRevenue
        : fundamentals?.enterpriseValue != null && fundamentals.revenue != null && fundamentals.revenue > 0
          ? fundamentals.enterpriseValue / fundamentals.revenue : null,
    fcfYield: compatibleCurrency && fundamentals?.freeCashFlow != null && quote?.marketCap != null && quote.marketCap > 0
      ? fundamentals.freeCashFlow / quote.marketCap : null,
    revenueGrowth: fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null,
    operatingMargin: fundamentals?.operatingMargin ?? null,
  };
}

export function comparableMarketCap(
  value: number | null,
  currency: string | null,
  baseCurrency: string,
  rates: ReadonlyMap<string, number>,
): number | null {
  if (value == null || !Number.isFinite(value) || !currency) return null;
  if (currency === baseCurrency) return value;
  const fromRate = currency === "USD" ? 1 : rates.get(currency);
  const toRate = baseCurrency === "USD" ? 1 : rates.get(baseCurrency);
  if (fromRate == null || toRate == null || !Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) return null;
  return value * fromRate / toRate;
}
