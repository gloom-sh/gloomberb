import { hasAsmlEarningsIdentity } from "../../utils/reported-earnings-result";
import { yahooSuffixExchange } from "../yahoo-finance/symbols";
import type { CachedResourceRecord, ResourceStore } from "../../data/resource-store";
import type { TimeRange } from "../../time-series/range";
import type { BrokerContractRef } from "../../types/instrument";
import type { Quote, TickerFinancials } from "../../types/financials";
import { withdrawKnownProviderStatements } from "../../utils/statement-observations";
import type { CachePolicy, CachePolicyMap } from "../../types/persistence";
import { canonicalExchange, parsePublicTickerKey } from "../../utils/exchanges";
import { brokerContractIdentityKey } from "../../utils/instrument-identity";
import { providerFinancialsMatchTarget, providerQuoteMatchesTarget } from "./financials";
import { hasShopOperatingIdentity, normalizeFinancialOperatingResults } from "../../utils/operating-result";

const MARKET_NAMESPACE = "market";
// A record written under another version is a miss: bump these instead of
// repairing older records on read.
export const FINANCIALS_SCHEMA_VERSION = 11;
export const QUOTE_SCHEMA_VERSION = 2;
const SCHEMA_VERSIONS: Record<string, number> = { financials: FINANCIALS_SCHEMA_VERSION, quote: QUOTE_SCHEMA_VERSION };

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
    const target = { symbol: entityKey, exchange: variantExchange(variantKey) };
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
    { cachePolicy, ...(SCHEMA_VERSIONS[kind] ? { schemaVersion: SCHEMA_VERSIONS[kind] } : {}) },
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

/** The listing a market cache variant key names, if any. */
export function variantExchange(variantKey: string | undefined): string | undefined {
  return variantKey?.match(/(?:^|;)exchange=([^;]+)/)?.[1];
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
    ...(SCHEMA_VERSIONS[kind] ? { schemaVersion: SCHEMA_VERSIONS[kind] } : {}),
  }).filter((record) => {
    if (!record.sourceKey.startsWith("provider:") || entityKey.startsWith("contract:")
      || (kind !== "financials" && kind !== "quote")) return true;
    const requestedExchange = parsePublicTickerKey(entityKey).exchange
      || canonicalExchange(variantExchange(variantKeys.find((key) => variantExchange(key) !== undefined)));
    // Check every declared identity before stale-quote sanitation or merging
    // can hide a conflicting symbol, metadata record or contribution.
    if (kind === "financials"
      ? !cachedProviderFinancialsMatchTarget(record.value as TickerFinancials, entityKey, requestedExchange)
      : !providerQuoteMatchesTarget(record.value as Quote, entityKey, requestedExchange)) return false;
    const quote = kind === "quote" ? record.value as Quote : (record.value as TickerFinancials).quote;
    const metadata = kind === "financials" ? (record.value as TickerFinancials).quoteMetadata : undefined;
    const declaredExchange = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName
      || metadata?.listingExchangeName || parsePublicTickerKey(quote?.symbol ?? metadata?.symbol ?? "").exchange);
    // Refetch a record that declares another public listing; never relabel it
    // or let it outrank a fresh exact-listing response.
    if (requestedExchange && declaredExchange && requestedExchange !== declaredExchange) return false;
    // A bare lookup that names no listing cannot say which venue it priced:
    // the unqualified BA quote is Boeing's, never BAE Systems' London line.
    return !(requestedExchange && !declaredExchange && !parsePublicTickerKey(entityKey).exchange
      && variantExchange(record.variantKey) === undefined);
  }).map((record) => {
    if (kind !== "financials") return record;
    const exchange = variantExchange(record.variantKey);
    const financials = record.value as TickerFinancials;
    const ownSymbol = financials.quote?.symbol ?? financials.quoteMetadata?.symbol;
    const withdrawn = withdrawKnownProviderStatements(financials, {
      symbol: record.entityKey.startsWith("contract:") ? ownSymbol ?? "" : record.entityKey, exchange,
    }, record.sourceKey);
    if (withdrawn !== record.value) record = { ...record, stale: true, value: withdrawn as T };
    if (!record.entityKey.startsWith("contract:")) record = { ...record,
      value: normalizeFinancialOperatingResults(record.value as TickerFinancials, { symbol: record.entityKey, exchange }) as T,
    };
    if (record.sourceKey !== "provider:gloomberb-cloud") return record;
    // A new client can cache an old backend response during a rolling deploy.
    // Require the metric's own provenance before reusing a cloud yield; retain
    // valid quotes and other issuer data.
    const value = record.value as TickerFinancials;
    const statistics = value.fundamentals;
    const hasDividendProvenance = ["forward", "trailing"].includes(statistics?.dividendYieldBasis ?? "")
      && ["twelvedata", "yahoo"].includes(statistics?.dividendYieldSource ?? "");
    if (statistics?.dividendYield == null || hasDividendProvenance) return record;
    return { ...record, stale: true, value: { ...value, fundamentals: { ...statistics,
      dividendYield: undefined, dividendYieldBasis: undefined, dividendYieldSource: undefined, dividendRate: undefined } } as T };
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
