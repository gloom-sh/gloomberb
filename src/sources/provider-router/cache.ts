import { hasAsmlEarningsIdentity } from "../../utils/reported-earnings-result";
import { yahooSuffixExchange } from "../yahoo-finance/symbols";
import type { CachedResourceRecord, ResourceStore } from "../../data/resource-store";
import type { TimeRange } from "../../time-series/range";
import type { BrokerContractRef } from "../../types/instrument";
import type { PricePoint, Quote, TickerFinancials } from "../../types/financials";
import { retractKnownCloudValuation } from "../gloomberb-cloud/valuation-observations";
import { withdrawKnownProviderStatements } from "../../utils/statement-observations";
import type { CachePolicy, CachePolicyMap } from "../../types/persistence";
import { canonicalExchange, parsePublicTickerKey, resolveExchangeTimeZone } from "../../utils/exchanges";
import { redactUnavailableFundamentals, RETRACTABLE_VALUATION_FIELDS } from "../../utils/fundamentals";
import { isPriceHistoryStaleForCurrentWindow } from "../../utils/price-history";
import { brokerContractIdentityKey } from "../../utils/instrument-identity";
import { providerFinancialsMatchTarget, providerQuoteMatchesTarget } from "./financials";
import { hasShopOperatingIdentity, normalizeFinancialOperatingResults } from "../../utils/operating-result";

const MARKET_NAMESPACE = "market";
const FINANCIALS_SCHEMA_VERSION = 11;
const QUOTE_SCHEMA_VERSION = 2;

const DEFAULT_CACHE_POLICIES = {
  brokerQuote: { staleMs: 15_000, expireMs: 15 * 60_000 },
  quote: { staleMs: 5 * 60_000, expireMs: 24 * 60 * 60_000 },
  financials: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  priceHistoryIntraday: { staleMs: 5 * 60_000, expireMs: 2 * 24 * 60 * 60_000 },
  priceHistoryDaily: { staleMs: 24 * 60 * 60_000, expireMs: 30 * 24 * 60 * 60_000 },
  news: { staleMs: 15 * 60_000, expireMs: 2 * 24 * 60 * 60_000 },
  holders: { staleMs: 24 * 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  analystResearch: { staleMs: 24 * 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
  corporateActions: { staleMs: 24 * 60 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
  secFilings: { staleMs: 15 * 60_000, expireMs: 2 * 24 * 60 * 60_000 },
  secFilingDocuments: { staleMs: 30 * 24 * 60 * 60_000, expireMs: 365 * 24 * 60 * 60_000 },
  secFilingContent: { staleMs: 30 * 24 * 60 * 60_000, expireMs: 365 * 24 * 60 * 60_000 },
  articleSummary: { staleMs: 30 * 24 * 60 * 60_000, expireMs: 90 * 24 * 60 * 60_000 },
  optionsChain: { staleMs: 5 * 60_000, expireMs: 2 * 24 * 60 * 60_000 },
  exchangeRate: { staleMs: 60 * 60_000, expireMs: 7 * 24 * 60 * 60_000 },
} satisfies Record<string, CachePolicy>;

export type ProviderRouterCachePolicyKey = keyof typeof DEFAULT_CACHE_POLICIES;

export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function compactUrl(url: string): string {
  return url.trim();
}

export function compactDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildVariantKey(parts: Array<[string, string | number | undefined | null]>): string {
  return parts
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(";");
}

export function getRouterEntityKey(ticker: string, instrument?: BrokerContractRef | null): string {
  if (instrument) return `contract:${brokerContractIdentityKey(instrument)}`;
  const target = parsePublicTickerKey(ticker);
  const suffixExchange = !target.exchange && yahooSuffixExchange(target.symbol);
  // Earlier bare-suffix caches may have parsed dates using unrelated exchange
  // metadata or UTC. A qualified entity bypasses those records on upgrade.
  return suffixExchange ? `${target.symbol}:${suffixExchange}` : normalizeTicker(ticker);
}

export function getTickerVariantCandidates(exchange?: string): string[] {
  const normalizedExchange = canonicalExchange(exchange);
  return [
    buildVariantKey([["exchange", normalizedExchange]]),
    "",
  ].filter((value, index, array) => value.length > 0 || array.indexOf(value) === index);
}

export function isIntradayRange(range: TimeRange): boolean {
  return range === "1D" || range === "1W" || range === "1M" || range === "3M";
}

export function isStaleIntradayHistory(points: PricePoint[], enabled: boolean, exchange?: string, intervalMs?: number | null): boolean {
  return enabled && isPriceHistoryStaleForCurrentWindow(points, Date.now(), { exchange, intervalMs });
}

export function isCurrentHistoryWindow(endDate?: Date): boolean {
  if (!endDate) return true;
  const endMs = endDate.getTime();
  return Number.isFinite(endMs) && Date.now() - endMs < 60 * 60_000;
}

export function resolveCachePolicy(
  overrides: CachePolicyMap | undefined,
  key: ProviderRouterCachePolicyKey,
): CachePolicy {
  return overrides?.[key] ?? DEFAULT_CACHE_POLICIES[key];
}

export function cacheRouterResource<T>(
  resources: ResourceStore | undefined,
  kind: string,
  entityKey: string,
  variantKey: string,
  sourceKey: string,
  value: T,
  cachePolicy: CachePolicy,
): void {
  if (kind === "financials" && ["provider:yahoo", "provider:gloomberb-cloud"].includes(sourceKey) && !entityKey.startsWith("contract:")) {
    const financials = value as TickerFinancials;
    const target = { symbol: entityKey, exchange: variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1] };
    const isRetry = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
    const retries = [
      isRetry(financials.operatingHistoryRetryAt) && hasShopOperatingIdentity(financials, target) ? financials.operatingHistoryRetryAt : undefined,
      isRetry(financials.earningsHistoryRetryAt) && hasAsmlEarningsIdentity(financials, target) ? financials.earningsHistoryRetryAt : undefined,
    ].filter(isRetry);
    const retryAt = Math.min(...retries);
    if (Number.isFinite(retryAt)) {
      // Keep usable partial statements while allowing the SEC source's
      // short retry (or completed background load) to escape the normal TTL.
      cachePolicy = { ...cachePolicy, staleMs: Math.min(cachePolicy.staleMs, Math.max(0, retryAt - Date.now())) };
    }
  }
  resources?.set(
    {
      namespace: MARKET_NAMESPACE,
      kind,
      entityKey,
      variantKey,
      sourceKey,
    },
    value,
    {
      cachePolicy,
      ...(kind === "financials" ? { schemaVersion: FINANCIALS_SCHEMA_VERSION } : {}),
      ...(kind === "quote" ? { schemaVersion: QUOTE_SCHEMA_VERSION } : {}),
    },
  );
}

export function sortCachedRecords<T>(
  records: CachedResourceRecord<T>[],
  variantKeys: string[],
  sourceKeys: string[],
): CachedResourceRecord<T>[] {
  const sourceRank = new Map(sourceKeys.map((sourceKey, index) => [sourceKey, index]));
  const variantRank = new Map(variantKeys.map((variantKey, index) => [variantKey, index]));
  return [...records].sort((a, b) => {
    if (a.expired !== b.expired) return a.expired ? 1 : -1;
    if (a.stale !== b.stale) return a.stale ? 1 : -1;
    const sourceDelta = (sourceRank.get(a.sourceKey) ?? Number.MAX_SAFE_INTEGER) - (sourceRank.get(b.sourceKey) ?? Number.MAX_SAFE_INTEGER);
    if (sourceDelta !== 0) return sourceDelta;
    const variantDelta = (variantRank.get(a.variantKey ?? "") ?? Number.MAX_SAFE_INTEGER) - (variantRank.get(b.variantKey ?? "") ?? Number.MAX_SAFE_INTEGER);
    if (variantDelta !== 0) return variantDelta;
    return b.fetchedAt - a.fetchedAt;
  });
}

function hasUnverifiedLegacyAsmlValuation(record: CachedResourceRecord, value: TickerFinancials): boolean {
  if (record.schemaVersion >= 6 || !RETRACTABLE_VALUATION_FIELDS.some((field) => value.fundamentals?.[field] != null)) return false;
  const target = parsePublicTickerKey(record.entityKey);
  const quote = parsePublicTickerKey(value.quote?.symbol ?? "");
  if (![target.symbol, quote.symbol].some((symbol) => symbol === "ASML" || symbol === "ASML.AS")) return false;
  const requested = target.exchange || (target.symbol === "ASML.AS" ? "AMS" : "")
    || canonicalExchange(record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1]);
  const rawListing = value.quote?.listingExchangeName || value.quote?.exchangeName || quote.exchange;
  const listing = canonicalExchange(rawListing);
  // Only corroborated non-US listings may retain their legacy valuation.
  // A requested venue alone does not prove which listing supplied old data.
  const verifiedForeign = ["ASML", "ASML.AS"].includes(quote.symbol) && resolveExchangeTimeZone(listing)
    && rawListing?.trim().toUpperCase() !== "EURONEXT" && !["NASDAQ", "NYSE", "AMEX", "ARCA"].includes(listing)
    && (!requested || requested === listing) && (!quote.exchange || quote.exchange === listing) && !!value.quote?.currency
    && (listing !== "AMS" || value.quote.currency === "EUR");
  return !verifiedForeign;
}

function cachedProviderFinancialsMatchTarget(value: TickerFinancials, symbol: string, exchange?: string): boolean {
  // Older cache metadata can contain only currency/type. Use the cache key
  // solely to validate its remaining declarations; never write an inferred
  // symbol into the returned metadata or bypass quote/contribution checks.
  const metadata = value.quoteMetadata;
  const checked = metadata && metadata.symbol === undefined
    ? { ...value, quoteMetadata: { ...metadata, symbol } }
    : value;
  return providerFinancialsMatchTarget(checked, symbol, exchange);
}

export function listCachedResources<T>(
  resources: ResourceStore | undefined,
  kind: string,
  entityKey: string,
  variantKeys: string[],
  sourceKeys: string[],
  allowExpired: boolean,
): CachedResourceRecord<T>[] {
  if (!resources) return [];
  const records = resources.list<T>({
    namespace: MARKET_NAMESPACE,
    kind,
    entityKey,
  }, {
    variantKeys,
    sourceKeys,
    allowExpired,
  }).filter((record) => {
    if (record.sourceKey.startsWith("provider:") && !entityKey.startsWith("contract:")
      && (kind === "financials" || kind === "quote")) {
      const requestedExchange = parsePublicTickerKey(entityKey).exchange
        || canonicalExchange(variantKeys.find((key) => /(?:^|;)exchange=/.test(key))?.match(/(?:^|;)exchange=([^;]+)/)?.[1]);
      // Check every declared identity before stale-quote sanitation or merging
      // can hide a conflicting symbol, metadata record or contribution.
      if (kind === "financials"
        ? !cachedProviderFinancialsMatchTarget(record.value as TickerFinancials, entityKey, requestedExchange)
        : !providerQuoteMatchesTarget(record.value as Quote, entityKey, requestedExchange)) return false;
      const quote = kind === "quote" ? record.value as Quote : (record.value as TickerFinancials).quote;
      const metadata = kind === "financials" ? (record.value as TickerFinancials).quoteMetadata : undefined;
      const declaredExchange = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName
        || metadata?.listingExchangeName || parsePublicTickerKey(quote?.symbol ?? metadata?.symbol ?? "").exchange);
      // Generic legacy entries can retain a venue normalized under old alias
      // rules (PCX used to mean AMEX). Refetch a conflicting public listing;
      // never relabel it or let it outrank a fresh exact-listing response.
      if (requestedExchange && declaredExchange && requestedExchange !== declaredExchange) return false;
      // A bare lookup that names no listing cannot say which venue it priced:
      // the unqualified BA quote is Boeing's, never BAE Systems' London line.
      if (requestedExchange && !declaredExchange && !parsePublicTickerKey(entityKey).exchange
        && !/(?:^|;)exchange=/.test(record.variantKey)) return false;
      // An unqualified lookup cannot tell real AMEX metadata from old PCX
      // normalization. Refresh only those legacy records; newly verified
      // AMEX data and explicitly requested AMEX listings remain reusable.
      if (!requestedExchange && declaredExchange === "AMEX"
        && record.schemaVersion < (kind === "financials" ? 8 : 2)) return false;
    }
    // The scoped reported operating cohort must be reacquired, never invented
    // from legacy independently selected fields. Other issuers/listings survive.
    if (kind === "financials" && record.schemaVersion < 10 && !record.entityKey.startsWith("contract:")
      && hasShopOperatingIdentity(record.value as TickerFinancials, {
        symbol: record.entityKey, exchange: record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1],
      })) return false;
    // The first operating-table implementation discarded independent sibling
    // documents and stamped the partial aggregate as complete. Reacquire only
    // affected native/cloud SHOP sources, including saved extended requests.
    if (kind === "financials" && record.schemaVersion < 11 && !record.entityKey.startsWith("contract:")
      && ["provider:yahoo", "provider:gloomberb-cloud"].includes(record.sourceKey)
      && hasShopOperatingIdentity(record.value as TickerFinancials, {
        symbol: record.entityKey, exchange: record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1],
      })) return false;
    // Earlier SEC projections used consolidated/common income as parent income.
    // Refetch the filing evidence; unrelated vendor statements remain usable.
    if (kind === "financials" && record.schemaVersion < 9) {
      const value = record.value as TickerFinancials;
      if ([...(value.annualStatements ?? []), ...(value.quarterlyStatements ?? [])]
        .some((row) => row.dateSource === "sec"
          && (row.netIncome !== undefined || row.netIncomeCommonStockholders !== undefined))) return false;
    }
    // Older SEC projections can mix pre/post-split EPS in one long history.
    // Refresh the source evidence instead of relabeling old numbers locally.
    if (kind === "financials" && record.schemaVersion < 7) {
      const value = record.value as TickerFinancials;
      if ([...(value.annualStatements ?? []), ...(value.quarterlyStatements ?? [])]
        .some((row) => row.dateSource === "sec" && row.eps !== undefined)) return false;
    }
    if (kind !== "financials" || record.schemaVersion >= 3) return true;
    // Earlier merges could date unknown fields from a partial availability map,
    // in addition to the older SEC annual/concept errors. Cached dates cannot
    // distinguish inferred metadata from source evidence; refresh dated rows.
    // Unrelated quote/history/company and undated financial caches remain usable.
    const value = record.value as TickerFinancials;
    return ![...(value.annualStatements ?? []), ...(value.quarterlyStatements ?? [])]
      .some((row) => row.availableAt || Object.keys(row.fieldAvailability ?? {}).length > 0);
  }).map((record) => {
    if (kind === "financials") {
      const financials = record.value as TickerFinancials;
      const ownSymbol = financials.quote?.symbol ?? financials.quoteMetadata?.symbol;
      const withdrawn = withdrawKnownProviderStatements(financials, {
        symbol: record.entityKey.startsWith("contract:") ? ownSymbol ?? "" : record.entityKey,
        exchange: record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1],
      }, record.sourceKey);
      if (withdrawn !== record.value) record = { ...record, stale: true, value: withdrawn as T };
      if (!record.entityKey.startsWith("contract:")) record = { ...record,
        value: normalizeFinancialOperatingResults(record.value as TickerFinancials, {
          symbol: record.entityKey, exchange: record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1],
        }) as T,
      };
    }
    if (kind !== "financials" || record.sourceKey !== "provider:gloomberb-cloud") return record;
    // Legacy cloud aggregates lost the nested quote's stale flag. Retain valid
    // issuer data, but obtain the quote through its independent freshness route.
    let value = record.value as TickerFinancials;
    const retracted = retractKnownCloudValuation(value, {
      symbol: record.entityKey,
      exchange: record.variantKey.match(/(?:^|;)exchange=([^;]+)/)?.[1],
    });
    const knownInvalidValuation = retracted !== value;
    value = retracted;
    const legacyValuation = hasUnverifiedLegacyAsmlValuation(record, value);
    if (record.schemaVersion < 4) value = { ...value, quote: undefined, quoteContributions: undefined };
    // A new client can cache an old backend response during a rolling deploy.
    // Require the metric's own provenance as well as the cache schema before
    // reusing a cloud yield; retain valid quotes and other issuer data.
    const statistics = value.fundamentals;
    const hasDividendProvenance = ["forward", "trailing"].includes(statistics?.dividendYieldBasis ?? "")
      && ["twelvedata", "yahoo"].includes(statistics?.dividendYieldSource ?? "");
    const legacyYield = statistics?.dividendYield != null && (record.schemaVersion < 5 || !hasDividendProvenance);
    if (legacyYield) value = { ...value, fundamentals: { ...value.fundamentals,
      dividendYield: undefined, dividendYieldBasis: undefined, dividendYieldSource: undefined, dividendRate: undefined } };
    if (legacyValuation) value = { ...value, fundamentals: redactUnavailableFundamentals({ ...value.fundamentals,
      unavailableFields: [...RETRACTABLE_VALUATION_FIELDS] }) };
    return { ...record, stale: record.stale || legacyYield || legacyValuation || knownInvalidValuation, value: value as T };
  });
  if (records.length === 0) return [];

  return sortCachedRecords(records, variantKeys, sourceKeys);
}

export function selectCachedResource<T>(
  resources: ResourceStore | undefined,
  kind: string,
  entityKey: string,
  variantKeys: string[],
  sourceKeys: string[],
  allowExpired: boolean,
): CachedResourceRecord<T> | null {
  return listCachedResources<T>(resources, kind, entityKey, variantKeys, sourceKeys, allowExpired)[0] ?? null;
}

export function selectCachedArrayResource<T>(
  resources: ResourceStore | undefined,
  kind: string,
  entityKey: string,
  variantKeys: string[],
  sourceKeys: string[],
  allowExpired: boolean,
): CachedResourceRecord<T[]> | null {
  const records = listCachedResources<T[]>(resources, kind, entityKey, variantKeys, sourceKeys, allowExpired);
  return records.find((record) => record.value.length > 0) ?? records[0] ?? null;
}
