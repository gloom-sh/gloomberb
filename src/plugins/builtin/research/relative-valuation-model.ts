import { comparablePriceEarnings } from "../../../utils/price-earnings";
import { selectMarketCapitalization } from "../../../utils/market-capitalization";
import type { TickerFinancials } from "../../../types/financials";
export { convertMarketCapitalization as comparableMarketCap } from "../../../utils/market-capitalization";

export function relativeValuationValues(financials: TickerFinancials | null) {
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const capitalization = selectMarketCapitalization(quote, fundamentals);
  const compatibleCurrency = !!fundamentals?.financialCurrency && !!quote?.currency
    && fundamentals.financialCurrency === quote.currency;
  const reportedMultiples = {
    trailingPE: fundamentals?.trailingPE != null && Number.isFinite(fundamentals.trailingPE) ? fundamentals.trailingPE : null,
    forwardPE: fundamentals?.forwardPE != null && Number.isFinite(fundamentals.forwardPE) ? fundamentals.forwardPE : null,
  };
  return {
    price: quote?.price ?? null,
    currency: quote?.currency ?? null,
    changePercent: quote?.changePercent ?? null,
    marketCap: capitalization?.value ?? null,
    marketCapCurrency: capitalization?.currency ?? null,
    marketCapProvenance: capitalization?.provenance ?? null,
    trailingPE: comparablePriceEarnings(reportedMultiples.trailingPE),
    forwardPE: comparablePriceEarnings(reportedMultiples.forwardPE),
    reportedMultiples,
    // Vendor ADR ratios can mix unverified valuation and reporting units too.
    evSales: !compatibleCurrency ? null
      : fundamentals?.enterpriseToRevenue != null && Number.isFinite(fundamentals.enterpriseToRevenue)
        ? fundamentals.enterpriseToRevenue
        : fundamentals?.enterpriseValue != null && fundamentals.revenue != null && fundamentals.revenue > 0
          ? fundamentals.enterpriseValue / fundamentals.revenue : null,
    fcfYield: capitalization && fundamentals?.financialCurrency === capitalization.currency
      && fundamentals.freeCashFlow != null && Number.isFinite(fundamentals.freeCashFlow) && capitalization.value > 0
      ? fundamentals.freeCashFlow / capitalization.value : null,
    revenueGrowth: fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null,
    operatingMargin: fundamentals?.operatingMargin ?? null,
  };
}
