import { formatCurrency } from "../../../utils/format";
import { comparablePriceEarnings, notMeaningfulMultiples } from "../../../utils/price-earnings";
import { marketCapBasisNote, viewMarketCapitalization } from "../../../utils/market-capitalization";
import { enterpriseValueReconciliationNote, enterpriseValueWithdrawn, reportedEnterpriseValue } from "../../../utils/fundamentals";
import { getExtendedSessionDisplay, getQuoteSessionFields } from "../../../market-data/market/status";
import { atRegularSessionPrice, movePriceDerivedFigures, regularSessionValuationPrice } from "../../../market-data/quotes/regular-session-valuation";
import type { Quote, TickerFinancials } from "../../../types/financials";

export function formatRelativePrice(price: number | null | undefined, currency: string | null | undefined): string {
  if (price == null) return "-";
  return formatCurrency(price, currency ?? "");
}

export const RELATIVE_VALUATION_STALE_QUOTE_NOTICE = "Quote stale: quote-based values unavailable";

/** The RV figures a row can lack, each with the short reason it draws in its place (GLO-1176). */
export type RelativeValuationGapKey = "price" | "changePercent" | "marketCap" | "trailingPE" | "forwardPE"
  | "evSales" | "fcfYield" | "revenueGrowth" | "operatingMargin";

const NOT_REPORTED = "not reported";
const QUOTE_STALE = "quote stale";

const finiteNumber = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

/** Why EV/S is missing, in the order the figure needs its parts. */
function evSalesGap(
  fundamentals: TickerFinancials["fundamentals"],
  quoteCurrency: string | undefined,
  withdrawn: boolean,
  enterpriseValueGap: boolean,
): string {
  if (withdrawn || enterpriseValueGap) return "EV unavailable";
  if (!fundamentals) return NOT_REPORTED;
  if (!finiteNumber(fundamentals.enterpriseToRevenue) && !finiteNumber(fundamentals.enterpriseValue)) return "no EV";
  if (!finiteNumber(fundamentals.enterpriseToRevenue) && !(finiteNumber(fundamentals.revenue) && fundamentals.revenue > 0)) return "no revenue";
  // EV/S is read only where the TTM block names its currency and it is the price's.
  if (!fundamentals.financialCurrency) return "revenue ccy unstated";
  if (quoteCurrency && fundamentals.financialCurrency !== quoteCurrency) return `revenue in ${fundamentals.financialCurrency}`;
  return NOT_REPORTED;
}

/** Why the FCF yield is missing: no trailing free cash flow, no cap, or the two in different currencies. */
function fcfYieldGap(fundamentals: TickerFinancials["fundamentals"], capCurrency: string | null): string {
  if (!finiteNumber(fundamentals?.freeCashFlow)) return "no TTM FCF";
  if (!capCurrency) return "no market cap";
  if (!fundamentals?.financialCurrency) return "FCF ccy unstated";
  if (fundamentals.financialCurrency !== capCurrency) return `FCF in ${fundamentals.financialCurrency}`;
  return NOT_REPORTED;
}
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
  // The cap `valuation` shows: the share count times the price where the provider's sits more than 2% from it.
  const capitalization = viewMarketCapitalization(quoteStale ? undefined : quote, fundamentals,
    quoteStale ? null : regularSessionValuationPrice(quote));
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
  const evSalesWithdrawn = enterpriseValueWithdrawn(fundamentals);
  const evSales = !compatibleCurrency || enterpriseValueGap ? null
    : fundamentals?.enterpriseToRevenue != null && Number.isFinite(fundamentals.enterpriseToRevenue)
      ? fundamentals.enterpriseToRevenue
      : enterpriseValue != null && fundamentals?.revenue != null && fundamentals.revenue > 0
        ? enterpriseValue / fundamentals.revenue : null;
  const fcfYield = capitalization && fundamentals?.financialCurrency === capitalization.currency
    && fundamentals.freeCashFlow != null && Number.isFinite(fundamentals.freeCashFlow) && capitalization.value > 0
    ? fundamentals.freeCashFlow / capitalization.value : null;
  const revenueGrowth = fundamentals?.revenueGrowth ?? fundamentals?.lastQuarterGrowth ?? null;
  const operatingMargin = fundamentals?.operatingMargin ?? null;
  const trailingPE = trailingNotMeaningful ? null : comparablePriceEarnings(reportedMultiples.trailingPE);
  const forwardPE = forwardNotMeaningful ? null : comparablePriceEarnings(reportedMultiples.forwardPE);
  // Every figure a row lacks says why, so an export's blank cell is never silent: N/M multiples say so themselves.
  const gaps: Partial<Record<RelativeValuationGapKey, string>> = {};
  if (session.price == null) gaps.price = quoteStale ? QUOTE_STALE : NOT_REPORTED;
  if (session.changePercent == null) gaps.changePercent = quoteStale ? QUOTE_STALE : NOT_REPORTED;
  if (capitalization == null) gaps.marketCap = quoteStale && !fundamentals?.marketCap ? QUOTE_STALE : NOT_REPORTED;
  if (trailingPE == null && !trailingNotMeaningful && reportedMultiples.trailingPE == null) gaps.trailingPE = NOT_REPORTED;
  if (forwardPE == null && !forwardNotMeaningful && reportedMultiples.forwardPE == null) gaps.forwardPE = NOT_REPORTED;
  if (evSales == null) gaps.evSales = evSalesGap(fundamentals, quote?.currency, evSalesWithdrawn, enterpriseValueGap);
  if (fcfYield == null) gaps.fcfYield = fcfYieldGap(fundamentals, capitalization?.currency ?? null);
  if (revenueGrowth == null) gaps.revenueGrowth = NOT_REPORTED;
  if (operatingMargin == null) gaps.operatingMargin = NOT_REPORTED;
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
    /** valuation's note when the cap is the share count times the price: the provider's figure it replaced. */
    marketCapNote: marketCapBasisNote(capitalization) ?? null,
    trailingPE,
    forwardPE,
    reportedMultiples,
    /** Why a multiple is N/M: its earnings base is zero or a loss. */
    notMeaningful,
    // Vendor ADR ratios can mix unverified valuation and reporting units too.
    evSales,
    /** Why EV/S is missing when the provider's EV was withdrawn, as `valuation` says it; null otherwise. */
    evSalesUnavailable: evSalesWithdrawn
      ? enterpriseValueReconciliationNote(fundamentals) ?? "EV unavailable." : null,
    fcfYield,
    revenueGrowth,
    operatingMargin,
    /** Why each missing figure is missing, in a few words the row draws in its place. */
    gaps,
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
