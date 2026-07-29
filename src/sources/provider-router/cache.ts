import type { CachedResourceRecord, ResourceStore } from "../../data/resource-store";
import type { TimeRange } from "../../time-series/range";
import type { BrokerContractRef } from "../../types/instrument";
import type { PricePoint } from "../../types/financials";
import type { CachePolicy, CachePolicyMap } from "../../types/persistence";
import { canonicalExchange } from "../../utils/exchanges";
import { isPriceHistoryStaleForCurrentWindow } from "../../utils/price-history";

const MARKET_NAMESPACE = "market";

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

export function isStaleIntradayHistory(points: PricePoint[], enabled: boolean, exchange?: string): boolean {
  return enabled && isPriceHistoryStaleForCurrentWindow(points, Date.now(), { exchange });
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
