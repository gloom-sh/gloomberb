import type { CachedResourceRecord, ResourceStore } from "../../data/resource-store";
import type { AnalystResearchData, CorporateActionsData, FinancialStatement, Fundamentals, Quote, TickerFinancials } from "../../types/financials";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { coalesceFinancialPeriodAliases, mergeFinancialStatementRows } from "../../utils/financial-statements";
import { normalizePriceHistory, normalizeTickerFinancialsPriceHistory } from "../../utils/price-history";
import { redactUnavailableFundamentals, RETRACTABLE_VALUATION_FIELDS } from "../../utils/fundamentals";
import { isExtendedHoursExchange, isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { mergeQuoteMetadata, quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../../market-data/quotes/metadata";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { activeUsMarketSession, isUsPriorSessionPremarketQuote } from "../../market-data/market/freshness";
import { normalizeStatementOperatingResult } from "../../utils/operating-result";
import {
  mergeQuoteContributionMaps,
  isQuoteContributionStaleForCurrentSession,
  resolveCanonicalQuote,
  resolveTickerFinancialsQuoteState,
  seedQuoteContributions,
} from "../../market-data/quotes/resolution";

export interface CachedFinancialsSelection {
  brokerRecord: CachedResourceRecord<TickerFinancials> | null;
  providerRecords?: CachedResourceRecord<TickerFinancials>[];
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

function researchInstrumentType(financials: Pick<TickerFinancials, "quote" | "quoteMetadata">): string | undefined {
  return (financials.quote?.instrumentType || financials.quoteMetadata?.instrumentType)?.toLowerCase().replace(/[\s_-]/g, "");
}

function isFundFinancials(financials: Pick<TickerFinancials, "quote" | "quoteMetadata">): boolean {
  return ["etf", "exchangetradedfund", "mutualfund", "fund"].includes(researchInstrumentType(financials) ?? "");
}

function excludeNonCompanyFinancials(financials: TickerFinancials): TickerFinancials {
  const type = researchInstrumentType(financials);
  if (!type || !["etf", "exchangetradedfund", "mutualfund", "fund", "index", "currency", "forex", "fx", "future", "futures", "cryptocurrency", "crypto", "digitalcurrency"].includes(type)) return financials;
  // An empty company response for a confirmed fund or other non-equity must
  // not inherit stale issuer accounts from a former symbol collision.
  const fund = isFundFinancials(financials);
  const statistics = financials.fundamentals;
  return {
    ...financials,
    financialCurrency: undefined,
    fundamentals: fund && statistics?.dividendYield != null ? {
      dividendYield: statistics.dividendYield,
      dividendYieldBasis: statistics.dividendYieldBasis,
      dividendYieldSource: statistics.dividendYieldSource,
      source: statistics.source,
      fetchedAt: statistics.fetchedAt,
      stale: statistics.stale,
    } : undefined,
    profile: fund && financials.profile?.description ? { description: financials.profile.description } : undefined,
    annualStatements: [],
    quarterlyStatements: [],
  };
}

export function sanitizeCachedFinancials(
  financials: TickerFinancials,
  options: { includeStaleQuotes?: boolean; allowIncompleteSession?: boolean } = {},
): TickerFinancials {
  financials = excludeNonCompanyFinancials({
    ...financials,
    fundamentals: redactUnavailableFundamentals(financials.fundamentals),
    annualStatements: coalesceFinancialPeriodAliases(financials.annualStatements.map(row => normalizeStatementOperatingResult(row, "annual"))),
    quarterlyStatements: coalesceFinancialPeriodAliases(financials.quarterlyStatements.map(row => normalizeStatementOperatingResult(row, "quarterly"))),
  });
  const stale = financials.quote && (options.allowIncompleteSession
    ? isQuoteContributionStaleForCurrentSession(financials.quote)
    : isQuoteStaleForCurrentSession(financials.quote));
  if (options.includeStaleQuotes || !stale) return financials;
  return {
    ...financials,
    quoteMetadata: mergeQuoteMetadata(quoteMetadataFromQuote(financials.quote!), financials.quoteMetadata),
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
function isQuoteInActiveSession(quote: Quote, now: number): boolean {
  if (isExtendedHoursExchange(quote)) return activeUsMarketSession(now) != null;
  const state = quote.marketState ?? "";
  if (state === "REGULAR") return true;
  return false;
}

function isActiveProviderQuoteTooOld(quote: Quote, now = Date.now()): boolean {
  if (!isQuoteInActiveSession(quote, now)) return false;
  // A prior-session close before any pre-market trade has no in-session print
  // to age; the session-date rules bound it instead.
  if (isUsPriorSessionPremarketQuote(quote.lastUpdated, quote.listingExchangeName || quote.exchangeName, quote.marketState, now)) {
    return false;
  }
  if (!Number.isFinite(quote.lastUpdated)) return false;
  const maxAge =
    quote.dataSource === "delayed"
      ? ACTIVE_DELAYED_PROVIDER_QUOTE_MAX_AGE_MS
      : ACTIVE_PROVIDER_QUOTE_MAX_AGE_MS;
  return now - quote.lastUpdated > maxAge;
}

export function providerQuoteMatchesTarget(quote: Quote | null | undefined, symbol?: string, exchange?: string): quote is Quote {
  if (!quote) return false;
  // Malformed source identity must reject this row, not throw out an entire
  // batch or prevent a cached record from falling through to a valid source.
  if (typeof quote.symbol !== "string" || !quote.symbol.trim()) return false;
  if ([quote.listingExchangeName, quote.exchangeName, quote.instrumentType]
    .some((value) => value != null && typeof value !== "string")) return false;
  if (symbol) {
    const metadata = quoteMetadataFromQuote(quote);
    // Older quote providers omit listing metadata. They must still return the
    // requested symbol; when they do name a listing it must agree as well.
    const hasListing = !!(metadata.listingExchangeName || parsePublicTickerKey(quote.symbol).exchange);
    if (!quoteMetadataMatchesTarget(metadata, hasListing ? symbol : parsePublicTickerKey(symbol).symbol, hasListing ? exchange : undefined)) return false;
  }
  return true;
}

export function isProviderQuoteUsableForCurrentSession(quote: Quote | null | undefined, exchange?: string, symbol?: string): quote is Quote {
  if (!providerQuoteMatchesTarget(quote, symbol, exchange)) return false;
  const normalized = quoteWithFreshnessExchange(quote, exchange);
  if (isQuoteStaleForCurrentSession(normalized)) return false;
  if (isActiveProviderQuoteTooOld(normalized)) return false;
  // Futures may trade or settle at zero or negative prices. Require explicit
  // source type metadata; an alias alone cannot establish the price domain.
  const futures = ["FUT", "FUTURE", "FUTURES"].includes(normalized.instrumentType?.trim().toUpperCase() ?? "");
  return [
    normalized.price,
    normalized.preMarketPrice,
    normalized.postMarketPrice,
    normalized.bid,
    normalized.ask,
    normalized.mark,
  ].some((value) => futures
    ? typeof value === "number" && Number.isFinite(value)
    : finitePositiveNumber(value));
}

export function providerFinancialsMatchTarget(value: TickerFinancials, symbol: string, exchange?: string): boolean {
  if (value.quote && !providerQuoteMatchesTarget(value.quote, symbol, exchange)) return false;
  if (Object.values(value.quoteContributions ?? {}).some((quote) => !providerQuoteMatchesTarget(quote, symbol, exchange))) return false;
  const metadata = value.quoteMetadata;
  if (!metadata) return true;
  if (typeof metadata.symbol !== "string" || !metadata.symbol.trim()
    || [metadata.listingExchangeName, metadata.instrumentType].some((field) => field != null && typeof field !== "string")) return false;
  const hasListing = !!(metadata.listingExchangeName || parsePublicTickerKey(metadata.symbol).exchange);
  return quoteMetadataMatchesTarget(metadata, hasListing ? symbol : parsePublicTickerKey(symbol).symbol, hasListing ? exchange : undefined);
}

export function dropUnusableProviderQuote(value: TickerFinancials, exchange?: string): TickerFinancials {
  if (!value.quote || isProviderQuoteUsableForCurrentSession(value.quote, exchange)) {
    return value;
  }

  return {
    ...value,
    quoteMetadata: mergeQuoteMetadata(quoteMetadataFromQuote(value.quote), value.quoteMetadata),
    quote: undefined,
    quoteContributions: undefined,
  };
}

function sanitizeCachedQuote(
  quote: Quote,
  exchange: string | undefined,
  options: { includeStaleQuotes?: boolean; allowIncompleteSession?: boolean } = {},
): Quote | null {
  const normalized = quoteWithFreshnessExchange(quote, exchange);
  const stale = options.allowIncompleteSession
    ? isQuoteContributionStaleForCurrentSession(normalized)
    : isQuoteStaleForCurrentSession(normalized);
  return options.includeStaleQuotes || !stale
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

/** A statement response can be complete while its company profile is missing. */
export function needsFinancialProfile(data: TickerFinancials | null | undefined): boolean {
  return hasStatementRows(data) && !hasMeaningfulProfile(data);
}

/** Retry a missing profile after a short pause, scoped to the listing and providers. */
export function hasRecentFinancialProfileAttempt(resources: ResourceStore | undefined, entityKey: string, variantKey: string, sourceKeys: string[]): boolean {
  const attempt = resources?.get<{ sourceKeys: string[] }>({ namespace: "market", kind: "financial-profile-attempt", entityKey, variantKey, sourceKey: "router" });
  return !!attempt && !attempt.stale && Array.isArray(attempt.value.sourceKeys)
    && attempt.value.sourceKeys.length === sourceKeys.length
    && attempt.value.sourceKeys.every((key, index) => key === sourceKeys[index]);
}

/** Company classification may only cross sources for the same explicit listing. */
export function profileForSameListing(source: TickerFinancials, target: TickerFinancials, request?: { symbol: string; exchange?: string }): TickerFinancials["profile"] {
  if (!hasMeaningfulProfile(source)) return undefined;
  const identity = (value: TickerFinancials) => [
    value.quote ? quoteMetadataFromQuote(value.quote) : undefined, value.quoteMetadata,
  ].find(metadata => metadata && typeof metadata.symbol === "string" && (metadata.listingExchangeName || parsePublicTickerKey(metadata.symbol).exchange));
  const actual = identity(source), requested = identity(target);
  if (!actual || !requested) return undefined;
  const symbol = request?.symbol ?? requested.symbol;
  const listing = parsePublicTickerKey(symbol).exchange || request?.exchange || requested.listingExchangeName || parsePublicTickerKey(requested.symbol).exchange;
  const actualListing = actual.listingExchangeName || parsePublicTickerKey(actual.symbol).exchange;
  if (typeof listing !== "string" || typeof actualListing !== "string" || !listing.trim() || !actualListing.trim()
    || !providerFinancialsMatchTarget(source, symbol, listing) || !providerFinancialsMatchTarget(target, symbol, listing)
    || !quoteMetadataMatchesTarget(requested, symbol, listing) || !quoteMetadataMatchesTarget(actual, symbol, listing)) return undefined;
  return source.profile;
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
    profile: mergeDefinedObject(primary.profile, profileForSameListing(fallback, primary)),
    statementHistory: fallback.statementHistory?.status === "available" ? fallback.statementHistory : primary.statementHistory ?? fallback.statementHistory,
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
  primary = redactUnavailableFundamentals(primary);
  fallback = redactUnavailableFundamentals(fallback);
  if (primary?.financialCurrency && fallback?.financialCurrency && primary.financialCurrency !== fallback.financialCurrency) {
    // Revenue and cash flows must come from the same reporting currency.
    return primary;
  }
  const merged = mergeDefinedObject(primary, fallback);
  if (merged) {
    const unavailable = new Set(fallback?.unavailableFields ?? []);
    for (const field of RETRACTABLE_VALUATION_FIELDS) {
      if (primary?.unavailableFields?.includes(field)) unavailable.add(field);
      else if (typeof primary?.[field] === "number" && Number.isFinite(primary[field])) unavailable.delete(field);
    }
    if (unavailable.size) merged.unavailableFields = [...unavailable];
    else delete merged.unavailableFields;
  }
  const dividend = primary?.dividendYield != null ? primary : fallback;
  if (merged && dividend) {
    // A yield's source and basis must come from the same observation as its
    // value, never from an unrelated fallback that supplied other metrics.
    merged.dividendYieldBasis = dividend.dividendYieldBasis;
    merged.dividendYieldSource = dividend.dividendYieldSource;
  }
  if (merged && primary && !primary.financialCurrency && [
    primary.revenue, primary.netIncome, primary.operatingCashFlow, primary.freeCashFlow, primary.eps,
  ].some((value) => value != null)) {
    // A fallback cannot retrospectively denominate an older cached snapshot.
    delete merged.financialCurrency;
  }
  return redactUnavailableFundamentals(merged);
}

export function mergeFinancials(primary: TickerFinancials | null, fallback: TickerFinancials | null): TickerFinancials | null {
  if (!primary || !fallback) {
    const single = primary ?? fallback;
    const resolved = single ? resolveTickerFinancialsQuoteState(normalizeTickerFinancialsPriceHistory(single)) : null;
    return resolved ? excludeNonCompanyFinancials({ ...resolved,
      fundamentals: redactUnavailableFundamentals(resolved.fundamentals),
    }) : null;
  }

  const preferFallbackPriceData = hasLikelyQuoteUnitMismatch(primary.quote, fallback.quote);
  const dominant = preferFallbackPriceData ? fallback : primary;
  const secondary = preferFallbackPriceData ? primary : fallback;
  const quoteContributions = mergeQuoteContributionMaps(
    seedQuoteContributions(primary),
    seedQuoteContributions(fallback),
  );
  const resolvedQuote = resolveCanonicalQuote(quoteContributions).quote;
  const metadata = (value: TickerFinancials) => mergeQuoteMetadata(
    value.quote ? quoteMetadataFromQuote(value.quote) : undefined, value.quoteMetadata,
  );
  const quoteMetadata = mergeQuoteMetadata(
    resolvedQuote ? quoteMetadataFromQuote(resolvedQuote) : undefined,
    mergeQuoteMetadata(metadata(primary), metadata(fallback)),
  );
  const resolvedIdentity = { quote: resolvedQuote, quoteMetadata };
  // A fund's distribution yield or description must not be borrowed from an
  // old company response for a colliding symbol. Only classified fund sources
  // can contribute those fields when the resolved security is a fund.
  const primaryResearch = isFundFinancials(resolvedIdentity) && !isFundFinancials(primary) ? undefined : primary;
  const fallbackResearch = isFundFinancials(resolvedIdentity) && !isFundFinancials(fallback) ? undefined : fallback;

  return excludeNonCompanyFinancials({
    ...fallback,
    ...primary,
    statementHistory: primary.statementHistory ?? fallback.statementHistory,
    financialCurrency: primary.financialCurrency ?? (hasStatementRows(primary) ? undefined : fallback.financialCurrency),
    quote: resolvedQuote,
    quoteMetadata,
    quoteContributions,
    profile: mergeDefinedObject(primaryResearch?.profile, fallbackResearch?.profile),
    fundamentals: mergeFundamentals(primaryResearch?.fundamentals, fallbackResearch?.fundamentals),
    priceHistory: normalizePriceHistory(dominant.priceHistory.length > 0 ? dominant.priceHistory : secondary.priceHistory),
    annualStatements: mergeFinancialStatementRows(primary.annualStatements, fallback.annualStatements),
    quarterlyStatements: mergeFinancialStatementRows(primary.quarterlyStatements, fallback.quarterlyStatements),
  });
}

/** Enrichment keeps existing quote/field priorities, but new valuation decisions
 * must supersede the older cache that caused this provider fetch. */
export function mergeRefreshedFinancials(cached: TickerFinancials, fresh: TickerFinancials | null): TickerFinancials {
  const merged = mergeFinancials(cached, fresh)!;
  const statistics = redactUnavailableFundamentals(fresh?.fundamentals);
  if (!statistics) return merged;
  const update: Fundamentals = { unavailableFields: statistics.unavailableFields };
  const currencyConflict = cached.fundamentals?.financialCurrency && statistics.financialCurrency
    && cached.fundamentals.financialCurrency !== statistics.financialCurrency;
  for (const field of RETRACTABLE_VALUATION_FIELDS) {
    if (!currencyConflict && typeof statistics[field] === "number" && Number.isFinite(statistics[field])) update[field] = statistics[field];
  }
  return excludeNonCompanyFinancials({ ...merged, fundamentals: mergeFundamentals(update, merged.fundamentals) });
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
  brokerSourceKeys: readonly string[] = [],
): CachedQuoteSelection {
  let stale = false;

  for (const record of records) {
    stale ||= record.stale === true;
    const quote = sanitizeCachedQuote(record.value, exchange, {
      ...options, allowIncompleteSession: brokerSourceKeys.includes(record.sourceKey),
    });
    if (quote) return { quote, stale };
  }

  return { quote: null, stale };
}
