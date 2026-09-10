import type { CachedResourceRecord } from "../../data/resource-store";
import type { AnalystResearchData, CorporateActionsData, FinancialStatement, Fundamentals, Quote, TickerFinancials } from "../../types/financials";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { coalesceFinancialPeriodAliases, mergeFinancialStatementRows } from "../../utils/financial-statements";
import { normalizePriceHistory, normalizeTickerFinancialsPriceHistory } from "../../utils/price-history";
import { isExtendedHoursExchange, isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import {
  mergeQuoteContributionMaps,
  resolveCanonicalQuote,
  resolveTickerFinancialsQuoteState,
  seedQuoteContributions,
} from "../../market-data/quotes/resolution";

export interface CachedFinancialsSelection {
  brokerRecord: CachedResourceRecord<TickerFinancials> | null;
  providerValue: TickerFinancials | null;
  value: TickerFinancials | null;
  stale: boolean;
}

export interface CachedFinancialsReadOptions {
  includeStaleQuotes?: boolean;
  includeSymbolProviderFallback?: boolean;
}

export interface CachedQuoteSelection {
  quote: Quote | null;
  stale: boolean;
}

function excludeNonCompanyFinancials(financials: TickerFinancials): TickerFinancials {
  const type = financials.quote?.instrumentType?.toLowerCase().replace(/[\s_-]/g, "");
  if (!type || !["etf", "exchangetradedfund", "mutualfund", "fund", "index", "currency", "forex", "fx", "future", "futures", "cryptocurrency", "crypto", "digitalcurrency"].includes(type)) return financials;
  // An empty company response for a confirmed fund or other non-equity must
  // not inherit stale issuer accounts from a former symbol collision.
  return { ...financials, financialCurrency: undefined, fundamentals: undefined, profile: undefined, annualStatements: [], quarterlyStatements: [] };
}

export function sanitizeCachedFinancials(
  financials: TickerFinancials,
  options: { includeStaleQuotes?: boolean } = {},
): TickerFinancials {
  financials = excludeNonCompanyFinancials({
    ...financials,
    annualStatements: coalesceFinancialPeriodAliases(financials.annualStatements),
    quarterlyStatements: coalesceFinancialPeriodAliases(financials.quarterlyStatements),
  });
  if (options.includeStaleQuotes || !isQuoteStaleForCurrentSession(financials.quote)) return financials;
  return {
    ...financials,
    quote: undefined,
    quoteContributions: undefined,
  };
}

export function quoteWithFreshnessExchange(quote: Quote, exchange?: string): Quote {
  if (!exchange || quote.listingExchangeName || quote.exchangeName) return quote;
  return {
    ...quote,
    listingExchangeName: exchange,
    exchangeName: exchange,
  };
}

function finitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const ACTIVE_PROVIDER_QUOTE_MAX_AGE_MS = 10 * 60_000;
// A delayed quote is built from the last completed one-minute bar fifteen
// minutes back, so a fresh one is already sixteen minutes old; leave room for
// the server cache on top of that before calling the provider stuck.
const ACTIVE_DELAYED_PROVIDER_QUOTE_MAX_AGE_MS = 30 * 60_000;

/**
 * PRE and POST are live sessions only where the exchange trades outside
 * regular hours. Yahoo reports POST for Tokyo or Sydney for hours after the
 * close, and that closing quote is exactly what a world board should show.
 */
function isQuoteInActiveSession(quote: Quote): boolean {
  const state = quote.marketState ?? "";
  if (state === "REGULAR") return true;
  if (state === "PRE" || state === "POST") return isExtendedHoursExchange(quote);
  return false;
}

function isActiveProviderQuoteTooOld(quote: Quote, now = Date.now()): boolean {
  if (!isQuoteInActiveSession(quote)) return false;
  if (!Number.isFinite(quote.lastUpdated)) return false;
  const maxAge =
    quote.dataSource === "delayed"
      ? ACTIVE_DELAYED_PROVIDER_QUOTE_MAX_AGE_MS
      : ACTIVE_PROVIDER_QUOTE_MAX_AGE_MS;
  return now - quote.lastUpdated > maxAge;
}

export function isProviderQuoteUsableForCurrentSession(quote: Quote | null | undefined, exchange?: string): quote is Quote {
  if (!quote) return false;
  const normalized = quoteWithFreshnessExchange(quote, exchange);
  if (isQuoteStaleForCurrentSession(normalized)) return false;
  if (isActiveProviderQuoteTooOld(normalized)) return false;
  return [
    normalized.price,
    normalized.preMarketPrice,
    normalized.postMarketPrice,
    normalized.bid,
    normalized.ask,
    normalized.mark,
  ].some(finitePositiveNumber);
}

export function dropUnusableProviderQuote(value: TickerFinancials, exchange?: string): TickerFinancials {
  if (!value.quote || isProviderQuoteUsableForCurrentSession(value.quote, exchange)) {
    return value;
  }

  return {
    ...value,
    quote: undefined,
    quoteContributions: undefined,
  };
}

function sanitizeCachedQuote(
  quote: Quote,
  exchange: string | undefined,
  options: { includeStaleQuotes?: boolean } = {},
): Quote | null {
  const normalized = quoteWithFreshnessExchange(quote, exchange);
  return options.includeStaleQuotes || !isQuoteStaleForCurrentSession(normalized)
    ? normalized
    : null;
}

export function hasMeaningfulProfile(data: TickerFinancials | null | undefined): boolean {
  return !!data && !!(
    data.profile?.description
    || data.profile?.sector
    || data.profile?.industry
  );
}

export function hasStatementRows(data: TickerFinancials | null | undefined): boolean {
  return !!data && (
    data.annualStatements.length > 0 ||
    data.quarterlyStatements.length > 0
  );
}

const DETAILED_STATEMENT_KEYS: Array<keyof FinancialStatement> = [
  "accountsReceivable",
  "inventory",
  "stockBasedCompensation",
  "purchaseOfPPE",
  "cashFlowFromContinuingOperatingActivities",
  "interestPaidSupplementalData",
  "accountsPayable",
  "currentDeferredRevenue",
  "additionalPaidInCapital",
  "totalNonCurrentAssets",
  "totalNonCurrentLiabilities",
];

export function hasDetailedStatementRows(data: TickerFinancials | null | undefined): boolean {
  if (!data) return false;
  const rows = [...data.annualStatements, ...data.quarterlyStatements];
  return rows.some((row) => DETAILED_STATEMENT_KEYS.some((key) => typeof row[key] === "number"));
}

export function hasDeepStatementHistory(data: TickerFinancials | null | undefined): boolean {
  if (!data) return false;
  return data.annualStatements.length >= 5 || data.quarterlyStatements.length >= 8;
}

export function hasShallowStatementHistory(data: TickerFinancials | null | undefined): boolean {
  return hasStatementRows(data) && !hasDeepStatementHistory(data);
}

export function mergeMissingStatementArrays(primary: TickerFinancials, fallback: TickerFinancials): TickerFinancials {
  return excludeNonCompanyFinancials({
    ...primary,
    financialCurrency: primary.financialCurrency ?? (hasStatementRows(primary) ? undefined : fallback.financialCurrency),
    annualStatements: mergeFinancialStatementRows(primary.annualStatements, fallback.annualStatements),
    quarterlyStatements: mergeFinancialStatementRows(primary.quarterlyStatements, fallback.quarterlyStatements),
  });
}

export function hasAnalystResearchValue(data: AnalystResearchData): boolean {
  return !!data.priceTarget
    || data.recommendations.length > 0
    || data.ratings.length > 0
    || data.earningsEstimates.length > 0
    || data.revenueEstimates.length > 0;
}

function hasAnalystRatingPriceTargets(data: AnalystResearchData): boolean {
  return data.ratings.some((rating) => (
    rating.currentPriceTarget != null || rating.priorPriceTarget != null
  ));
}

export function isAnalystResearchMissingRatingTargets(data: AnalystResearchData): boolean {
  return data.ratings.length > 0 && !hasAnalystRatingPriceTargets(data);
}

export function hasCorporateActionsValue(data: CorporateActionsData): boolean {
  return data.dividends.length > 0
    || data.splits.length > 0
    || data.earnings.length > 0;
}

function mergeDefinedObject<T extends object>(preferred: T | null | undefined, fallback: T | null | undefined): T | undefined {
  const mergedEntries: Array<[string, unknown]> = [];

  for (const source of [fallback, preferred]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) {
        mergedEntries.push([key, value]);
      }
    }
  }

  if (mergedEntries.length === 0) return undefined;
  return Object.fromEntries(mergedEntries) as T;
}

function mergeFundamentals(primary: Fundamentals | undefined, fallback: Fundamentals | undefined): Fundamentals | undefined {
  if (primary?.financialCurrency && fallback?.financialCurrency && primary.financialCurrency !== fallback.financialCurrency) {
    // Revenue and cash flows must come from the same reporting currency.
    return primary;
  }
  const merged = mergeDefinedObject(primary, fallback);
  if (merged && primary && !primary.financialCurrency && [
    primary.revenue, primary.netIncome, primary.operatingCashFlow, primary.freeCashFlow, primary.eps,
  ].some((value) => value != null)) {
    // A fallback cannot retrospectively denominate an older cached snapshot.
    delete merged.financialCurrency;
  }
  return merged;
}

export function mergeFinancials(primary: TickerFinancials | null, fallback: TickerFinancials | null): TickerFinancials | null {
  if (!primary || !fallback) {
    const single = primary ?? fallback;
    const resolved = single ? resolveTickerFinancialsQuoteState(normalizeTickerFinancialsPriceHistory(single)) : null;
    return resolved ? excludeNonCompanyFinancials(resolved) : null;
  }

  const preferFallbackPriceData = hasLikelyQuoteUnitMismatch(primary.quote, fallback.quote);
  const dominant = preferFallbackPriceData ? fallback : primary;
  const secondary = preferFallbackPriceData ? primary : fallback;
  const quoteContributions = mergeQuoteContributionMaps(
    seedQuoteContributions(primary),
    seedQuoteContributions(fallback),
  );
  const resolvedQuote = resolveCanonicalQuote(quoteContributions).quote;

  return excludeNonCompanyFinancials({
    ...fallback,
    ...primary,
    financialCurrency: primary.financialCurrency ?? (hasStatementRows(primary) ? undefined : fallback.financialCurrency),
    quote: resolvedQuote,
    quoteContributions,
    profile: mergeDefinedObject(primary.profile, fallback.profile),
    fundamentals: mergeFundamentals(primary.fundamentals, fallback.fundamentals),
    priceHistory: normalizePriceHistory(dominant.priceHistory.length > 0 ? dominant.priceHistory : secondary.priceHistory),
    annualStatements: mergeFinancialStatementRows(primary.annualStatements, fallback.annualStatements),
    quarterlyStatements: mergeFinancialStatementRows(primary.quarterlyStatements, fallback.quarterlyStatements),
  });
}

export function mergeCachedFinancialRecords(
  records: CachedResourceRecord<TickerFinancials>[],
  options: { includeStaleQuotes?: boolean } = {},
): {
  value: TickerFinancials | null;
  stale: boolean;
} {
  let merged: TickerFinancials | null = null;
  let stale = false;

  for (const record of records) {
    merged = mergeFinancials(merged, sanitizeCachedFinancials(record.value, options));
    stale = stale || record.stale === true;
  }

  return { value: merged, stale };
}

export function selectCachedQuoteRecord(
  records: CachedResourceRecord<Quote>[],
  exchange: string | undefined,
  options: { includeStaleQuotes?: boolean } = {},
): CachedQuoteSelection {
  let stale = false;

  for (const record of records) {
    stale ||= record.stale === true;
    const quote = sanitizeCachedQuote(record.value, exchange, options);
    if (quote) return { quote, stale };
  }

  return { quote: null, stale };
}
