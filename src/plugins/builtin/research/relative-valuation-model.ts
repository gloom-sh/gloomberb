import type { TickerFinancials } from "../../../types/financials";

export function relativeValuationValues(financials: TickerFinancials | null) {
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  return {
    price: quote?.price ?? null,
    currency: quote?.currency ?? null,
    changePercent: quote?.changePercent ?? null,
    marketCap: quote?.marketCap ?? null,
    trailingPE: fundamentals?.trailingPE ?? null,
    forwardPE: fundamentals?.forwardPE ?? null,
    evSales: fundamentals?.enterpriseValue != null && fundamentals.revenue
      ? fundamentals.enterpriseValue / fundamentals.revenue : null,
    fcfYield: fundamentals?.freeCashFlow != null && quote?.marketCap
      ? fundamentals.freeCashFlow / quote.marketCap : null,
    revenueGrowth: fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null,
    operatingMargin: fundamentals?.operatingMargin ?? null,
  };
}
