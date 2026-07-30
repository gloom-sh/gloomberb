import type { CachedResourceRecord } from "../../data/resource-store";
import type { AnalystResearchData, CorporateActionsData, FinancialStatement, Quote, TickerFinancials } from "../../types/financials";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { mergeFinancialStatementRows } from "../../utils/financial-statements";
import { normalizePriceHistory, normalizeTickerFinancialsPriceHistory } from "../../utils/price-history";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
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

export function deriveMarketCapFromShares(
  financials: TickerFinancials,
  options: { replaceExisting?: boolean } = {},
): TickerFinancials {
  const quote = financials.quote;
  const sharesOutstanding = financials.fundamentals?.sharesOutstanding;
  if (
    !quote
    || (quote.marketCap != null && !options.replaceExisting)
    || !Number.isFinite(quote.price)
    || !Number.isFinite(sharesOutstanding)
    || quote.price <= 0
    || !sharesOutstanding
    || sharesOutstanding <= 0
  ) {
    return financials;
  }

  return {
    ...financials,
    quote: {
      ...quote,
      marketCap: quote.price * sharesOutstanding,
    },
  };
}

export function sanitizeCachedFinancials(
  financials: TickerFinancials,
  options: { includeStaleQuotes?: boolean } = {},
): TickerFinancials {
  const enriched = deriveMarketCapFromShares(financials);
  if (options.includeStaleQuotes || !isQuoteStaleForCurrentSession(enriched.quote)) return enriched;
  return {
    ...enriched,
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
const ACTIVE_DELAYED_PROVIDER_QUOTE_MAX_AGE_MS = 20 * 60_000;
const ACTIVE_QUOTE_MARKET_STATES = new Set(["PRE", "REGULAR", "POST"]);

function isActiveProviderQuoteTooOld(quote: Quote, now = Date.now()): boolean {
  if (!ACTIVE_QUOTE_MARKET_STATES.has(quote.marketState ?? "")) return false;
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
  return {
    ...primary,
    annualStatements: mergeFinancialStatementRows(primary.annualStatements, fallback.annualStatements),
    quarterlyStatements: mergeFinancialStatementRows(primary.quarterlyStatements, fallback.quarterlyStatements),
  };
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

export function mergeFinancials(primary: TickerFinancials | null, fallback: TickerFinancials | null): TickerFinancials | null {
  if (!primary || !fallback) {
    const single = primary ?? fallback;
    const resolved = single ? resolveTickerFinancialsQuoteState(normalizeTickerFinancialsPriceHistory(single)) : null;
    return resolved ? deriveMarketCapFromShares(resolved) : null;
  }

  const preferFallbackPriceData = hasLikelyQuoteUnitMismatch(primary.quote, fallback.quote);
  const dominant = preferFallbackPriceData ? fallback : primary;
  const secondary = preferFallbackPriceData ? primary : fallback;
  const quoteContributions = mergeQuoteContributionMaps(
    seedQuoteContributions(primary),
    seedQuoteContributions(fallback),
  );
  const resolvedQuote = resolveCanonicalQuote(quoteContributions).quote;

  return deriveMarketCapFromShares({
    ...fallback,
    ...primary,
    quote: resolvedQuote,
    quoteContributions,
    profile: mergeDefinedObject(primary.profile, fallback.profile),
    fundamentals: mergeDefinedObject(primary.fundamentals, fallback.fundamentals),
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
