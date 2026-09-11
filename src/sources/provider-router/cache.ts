import type { CachedResourceRecord, ResourceStore } from "../../data/resource-store";
import type { TimeRange } from "../../time-series/range";
import type { BrokerContractRef } from "../../types/instrument";
import type { PricePoint, TickerFinancials } from "../../types/financials";
import type { CachePolicy, CachePolicyMap } from "../../types/persistence";
import { canonicalExchange, parsePublicTickerKey, resolveExchangeTimeZone } from "../../utils/exchanges";
import { redactUnavailableFundamentals, RETRACTABLE_VALUATION_FIELDS } from "../../utils/fundamentals";
import { isPriceHistoryStaleForCurrentWindow } from "../../utils/price-history";

const MARKET_NAMESPACE = "market";
const FINANCIALS_SCHEMA_VERSION = 7;

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
  if (instrument?.conId != null) return `contract:${instrument.conId}`;
  if (instrument?.localSymbol) return `contract:${instrument.localSymbol.toUpperCase()}`;
  if (instrument?.symbol) return `contract:${instrument.symbol.toUpperCase()}`;
  return normalizeTicker(ticker);
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
    if (kind !== "financials" || record.sourceKey !== "provider:gloomberb-cloud") return record;
    // Legacy cloud aggregates lost the nested quote's stale flag. Retain valid
    // issuer data, but obtain the quote through its independent freshness route.
    let value = record.value as TickerFinancials;
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
      dividendYield: undefined, dividendYieldBasis: undefined, dividendYieldSource: undefined } };
    if (legacyValuation) value = { ...value, fundamentals: redactUnavailableFundamentals({ ...value.fundamentals,
      unavailableFields: [...RETRACTABLE_VALUATION_FIELDS] }) };
    return { ...record, stale: record.stale || legacyYield || legacyValuation, value: value as T };
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
