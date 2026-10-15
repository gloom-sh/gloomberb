import { comparablePriceEarnings, notMeaningfulMultiples } from "../../../utils/price-earnings";
import { selectMarketCapitalization } from "../../../utils/market-capitalization";
import { enterpriseValueReconciliationNote, enterpriseValueWithdrawn, reportedEnterpriseValue } from "../../../utils/fundamentals";
import { getExtendedSessionDisplay, getQuoteSessionFields } from "../../../market-data/market/status";
import { atRegularSessionPrice, movePriceDerivedFigures } from "../../../market-data/quotes/regular-session-valuation";
import type { Quote, TickerFinancials } from "../../../types/financials";

export const RELATIVE_VALUATION_STALE_QUOTE_NOTICE = "Quote stale: quote-based values unavailable";
export const RELATIVE_VALUATION_STALE_FUNDAMENTALS_NOTICE = "Fundamentals stale: retained values may be out of date";

/**
 * A peer's row. Last, its change and the extended print are the quote's
 * sessions as `quote` reads them (getQuoteSessionFields): after the close,
 * the close and its move, and the pre-market or after-hours print measured
 * from it. Every figure measured at the price (market cap, P/E, forward P/E
 * and through the cap the FCF yield) is at that regular session price too.
 */
export function relativeValuationValues(snapshot: TickerFinancials | null) {
  const reported = snapshot?.quote;
  const financials = snapshot ? atRegularSessionPrice(snapshot) : null;
  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const quoteStale = quote?.stale === true;
  const session = getQuoteSessionFields(quoteStale ? null : quote);
  // An overnight price that is the session's bid and ask midpoint, nothing having traded in it.
  const extendedMark = !quoteStale && getExtendedSessionDisplay(quote)?.mark === true;
  const capitalization = selectMarketCapitalization(quoteStale ? undefined : quote, fundamentals);
  const enterpriseValue = reportedEnterpriseValue(fundamentals);
  // A zero or non-finite enterprise value is the source's gap, and the ratio it serves beside it comes from the same observation.
  const enterpriseValueGap = fundamentals?.enterpriseValue != null && enterpriseValue == null;
  const compatibleCurrency = !!fundamentals?.financialCurrency && !!quote?.currency
    && fundamentals.financialCurrency === quote.currency;
  const reportedMultiples = {
    trailingPE: fundamentals?.trailingPE != null && Number.isFinite(fundamentals.trailingPE) ? fundamentals.trailingPE : null,
    forwardPE: fundamentals?.forwardPE != null && Number.isFinite(fundamentals.forwardPE) ? fundamentals.forwardPE : null,
  };
  // A multiple over a loss reads N/M even when the source served a positive one beside it.
  const { trailingPE: trailingNotMeaningful, forwardPE: forwardNotMeaningful } = notMeaningfulMultiples(fundamentals);
  const notMeaningful = {
    ...(trailingNotMeaningful ? { trailingPE: trailingNotMeaningful } : {}),
    ...(forwardNotMeaningful ? { forwardPE: forwardNotMeaningful } : {}),
  };
  return {
    ...session,
    extendedMark,
    quoteStale: quote?.stale ?? null,
    quoteAsOf: quote && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? quote.lastUpdated : null,
    // The observation as sent, apart from the values used for comparison: a rejected stale quote, or the print the source priced.
    reportedQuote: reported ? {
      price: reported.price, changePercent: reported.changePercent, marketCap: reported.marketCap ?? null,
      currency: reported.currency, lastUpdated: reported.lastUpdated, stale: reported.stale ?? null,
      providerId: reported.providerId ?? null, dataSource: reported.dataSource ?? null,
    } : null,
    fundamentalsProvenance: fundamentals ? {
      source: fundamentals.source ?? null, retrievedAt: fundamentals.fetchedAt ?? null,
      stale: fundamentals.stale ?? null,
    } : null,
    currency: quote?.currency ?? null,
    marketCap: capitalization?.value ?? null,
    marketCapCurrency: capitalization?.currency ?? null,
    marketCapProvenance: capitalization?.provenance ?? null,
    trailingPE: trailingNotMeaningful ? null : comparablePriceEarnings(reportedMultiples.trailingPE),
    forwardPE: forwardNotMeaningful ? null : comparablePriceEarnings(reportedMultiples.forwardPE),
    reportedMultiples,
    /** Why a multiple is N/M: its earnings base is zero or a loss. */
    notMeaningful,
    // Vendor ADR ratios can mix unverified valuation and reporting units too.
    evSales: !compatibleCurrency || enterpriseValueGap ? null
      : fundamentals?.enterpriseToRevenue != null && Number.isFinite(fundamentals.enterpriseToRevenue)
        ? fundamentals.enterpriseToRevenue
        : enterpriseValue != null && fundamentals?.revenue != null && fundamentals.revenue > 0
          ? enterpriseValue / fundamentals.revenue : null,
    /** Why EV/S is missing when the provider's EV was withdrawn, as `valuation` says it; null otherwise. */
    evSalesUnavailable: enterpriseValueWithdrawn(fundamentals)
      ? enterpriseValueReconciliationNote(fundamentals) ?? "EV unavailable." : null,
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

/** What a quote says about its sessions; a newer quote's replaces the snapshot's whole, so a close never pairs with another day's print. */
const SESSION_FIELDS = [
  "marketState", "changeSessionDate", "regularClose", "regularCloseSessionDate", "regularChange", "regularChangePercent",
  "preMarketPrice", "preMarketChange", "preMarketChangePercent", "postMarketPrice", "postMarketChange", "postMarketChangePercent",
  "extendedSessionPrint", "overnightPrice", "overnightChange", "overnightChangePercent", "overnightPriceKind",
] as const satisfies readonly (keyof Quote)[];

/**
 * The snapshot with a newer quote laid over it, its sessions included, so
 * relativeValuationValues reads the newer quote's regular session and
 * extended print. Fundamentals stay from the snapshot. Values measured
 * against the price move by live price / snapshot price (and from there to
 * the regular session price in relativeValuationValues), but only from a
 * price they were measured at: the quote's market cap (and through it the
 * FCF yield) when the snapshot quote is not stale, and the fundamentals'
 * price-derived figures (movePriceDerivedFigures: the P/E multiples, the cap,
 * and the equity part of the enterprise value and EV/Sales) when the
 * fundamentals are not stale either. A stale snapshot quote drops its cap, so
 * the row falls back to the fundamentals' cap as it would without the live
 * quote. A quote in another currency, or a stale one, leaves the snapshot
 * alone.
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
    previousClose: live.previousClose ?? base.previousClose,
    ...Object.fromEntries(SESSION_FIELDS.map((key) => [key, live[key]])),
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
    fundamentals: fundamentals && fundamentals.stale !== true ? movePriceDerivedFigures(fundamentals, live.currency, ratio) : fundamentals,
  };
}
