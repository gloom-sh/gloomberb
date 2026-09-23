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
 * snapshot. Values measured against the price move by live price / snapshot
 * price, but only from a price they were measured at: the quote's market cap
 * (and through it the FCF yield) when the snapshot quote is not stale, and the
 * P/E multiples and the fundamentals' cap when the fundamentals are not stale
 * either. A stale snapshot quote drops its cap, so the row falls back to the
 * fundamentals' cap as it would without the live quote. EV/Sales stays at the
 * snapshot: only its equity part moves with the price, and the snapshot does
 * not say how large that part is. A quote in another currency, or a stale one,
 * leaves the snapshot alone.
 */
export function withLiveQuote(financials: TickerFinancials | null, live: Quote | null | undefined): TickerFinancials | null {
  const base = financials?.quote;
  if (!financials || !base || !live || live === base || live.stale) return financials;
  if (!live.currency || live.currency !== base.currency) return financials;
  if (!(live.price > 0) || !Number.isFinite(live.price)) return financials;
  if (live.lastUpdated < base.lastUpdated) return financials;
  const quote: Quote = {
    ...base,
    price: live.price,
    change: live.change,
    changePercent: live.changePercent,
    lastUpdated: live.lastUpdated,
    stale: live.stale,
    ...(live.dataSource ? { dataSource: live.dataSource } : {}),
  };
  if (base.stale || !(base.price > 0)) {
    return { ...financials, quote: { ...quote, marketCap: undefined } };
  }
  const ratio = live.price / base.price;
  const fundamentals = financials.fundamentals;
  return {
    ...financials,
    quote: { ...quote, marketCap: scaled(base.marketCap, ratio) },
    fundamentals: fundamentals && fundamentals.stale !== true ? {
      ...fundamentals,
      trailingPE: scaled(fundamentals.trailingPE, ratio),
      forwardPE: scaled(fundamentals.forwardPE, ratio),
      marketCap: fundamentals.marketCapCurrency === live.currency ? scaled(fundamentals.marketCap, ratio) : fundamentals.marketCap,
    } : fundamentals,
  };
}
