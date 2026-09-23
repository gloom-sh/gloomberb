import { comparablePriceEarnings } from "../../../utils/price-earnings";
import { selectMarketCapitalization } from "../../../utils/market-capitalization";
import type { Quote, TickerFinancials } from "../../../types/financials";
export { convertMarketCapitalization as comparableMarketCap } from "../../../utils/market-capitalization";

export const RELATIVE_VALUATION_STALE_QUOTE_NOTICE = "Quote stale: quote-based values unavailable";
export const RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE = "Fundamentals stale: retained values may be out of date";

export function relativeValuationValues(financials: TickerFinancials | null) {
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const quoteStale = quote?.stale === true;
  const capitalization = selectMarketCapitalization(quoteStale ? undefined : quote, fundamentals);
  const compatibleCurrency = !!fundamentals?.financialCurrency && !!quote?.currency
    && fundamentals.financialCurrency === quote.currency;
  const reportedMultiples = {
    trailingPE: fundamentals?.trailingPE != null && Number.isFinite(fundamentals.trailingPE) ? fundamentals.trailingPE : null,
    forwardPE: fundamentals?.forwardPE != null && Number.isFinite(fundamentals.forwardPE) ? fundamentals.forwardPE : null,
  };
  return {
    price: quoteStale ? null : quote?.price ?? null,
    quoteStale: quote?.stale ?? null,
    quoteAsOf: quote && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? quote.lastUpdated : null,
    // Retain the rejected observation separately from values used for comparison.
    reportedQuote: quote ? {
      price: quote.price, changePercent: quote.changePercent, marketCap: quote.marketCap ?? null,
      currency: quote.currency, lastUpdated: quote.lastUpdated, stale: quote.stale ?? null,
      providerId: quote.providerId ?? null, dataSource: quote.dataSource ?? null,
    } : null,
    fundamentalsProvenance: fundamentals ? {
      source: fundamentals.source ?? null, retrievedAt: fundamentals.fetchedAt ?? null,
      stale: fundamentals.stale ?? null,
    } : null,
    currency: quote?.currency ?? null,
    changePercent: quoteStale ? null : quote?.changePercent ?? null,
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

function scaled(value: number | undefined, ratio: number): number | undefined {
  return value != null && Number.isFinite(value) ? value * ratio : value;
}

/**
 * The snapshot with a newer quote laid over it. Fundamentals stay from the
 * snapshot; everything measured against the price (market cap, and through it
 * the FCF yield, and the P/E multiples) moves by live price / snapshot price.
 * A quote in another currency, or a stale one, leaves the snapshot alone.
 */
export function withLiveQuote(financials: TickerFinancials | null, live: Quote | null | undefined): TickerFinancials | null {
  const base = financials?.quote;
  if (!financials || !base || !live || live === base || live.stale) return financials;
  if (!live.currency || live.currency !== base.currency) return financials;
  if (!(base.price > 0) || !(live.price > 0) || !Number.isFinite(live.price)) return financials;
  if (live.lastUpdated < base.lastUpdated) return financials;
  const ratio = live.price / base.price;
  const fundamentals = financials.fundamentals;
  return {
    ...financials,
    quote: {
      ...base,
      price: live.price,
      change: live.change,
      changePercent: live.changePercent,
      lastUpdated: live.lastUpdated,
      stale: live.stale,
      ...(live.dataSource ? { dataSource: live.dataSource } : {}),
      marketCap: scaled(base.marketCap, ratio),
    },
    fundamentals: fundamentals ? {
      ...fundamentals,
      trailingPE: scaled(fundamentals.trailingPE, ratio),
      forwardPE: scaled(fundamentals.forwardPE, ratio),
      marketCap: fundamentals.marketCapCurrency === live.currency ? scaled(fundamentals.marketCap, ratio) : fundamentals.marketCap,
    } : fundamentals,
  };
}
