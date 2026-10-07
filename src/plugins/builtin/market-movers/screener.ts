import type { ScreenerQuote } from "../../../api-client/market-discovery";
export type { ScreenerQuote } from "../../../api-client/market-discovery";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
import type { PluginPersistence } from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import type {
  CloudMarketResponse,
  CloudMarketScreenerCategory,
  CloudMarketScreenerItem,
  CloudMarketScreenerPayload,
} from "../../../api-client/types";
import { hasProAccess } from "../../../api-client/plan-access";

const CACHE_KIND = "market-screener";
const CACHE_SOURCE = "gloom";
const CACHE_SCHEMA_VERSION = 3;
const CACHE_POLICY = {
  staleMs: 5 * 60 * 1000,
  expireMs: 60 * 60 * 1000,
} as const;
/** A pane shows the live ranking first; the backend's average volumes follow if they are quick. */
const MARKET_METADATA_WAIT_MS = 1_500;

export interface MarketScreenerApi {
  getMarketMovers: Pick<typeof apiClient, "getMarketMovers">["getMarketMovers"];
  getMarketTrending?: Pick<typeof apiClient, "getMarketTrending">["getMarketTrending"];
}

export interface FetchCacheOptions {
  cache?: boolean;
  forceRefresh?: boolean;
}

export interface PreferredMoversOptions extends FetchCacheOptions {
  /**
   * How long a Cloud list waits for the backend's average volumes and market
   * caps, which it borrows by symbol: without them every row has no ratio.
   */
  metadataWaitMs?: number;
}

let marketMoversPersistence: PluginPersistence | null = null;
const activeFetches = new Map<string, Promise<unknown>>();
const failedFetches = new Set<string>();

export function attachMarketMoversPersistence(persistence: PluginPersistence): void {
  marketMoversPersistence = persistence;
}

export function resetMarketMoversPersistence(): void {
  marketMoversPersistence = null;
  activeFetches.clear();
  failedFetches.clear();
}

const screenerApi: MarketScreenerApi = apiClient;

function shouldUseCache(api: MarketScreenerApi, options?: FetchCacheOptions): boolean {
  return options?.cache === true || (options?.cache !== false && api === screenerApi);
}

function readCache<T>(key: string, options?: { allowExpired?: boolean }): { data: T; stale: boolean } | null {
  const record = marketMoversPersistence?.getResource<CachedResult<T>>(CACHE_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record) return null;

  return {
    data: record.value.data,
    stale: record.value.stale || !!record.stale || failedFetches.has(key),
  };
}

function writeCache<T>(key: string, data: T): void {
  marketMoversPersistence?.setResource(CACHE_KIND, key, data, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: CACHE_POLICY,
  });
}

/** A cached value plus whether it is a fallback rather than a fresh load. */
export interface CachedResult<T> {
  data: T;
  stale: boolean;
}

async function loadCached<T>(
  key: string,
  fetcher: () => Promise<CachedResult<T>>,
  options?: FetchCacheOptions,
): Promise<CachedResult<T>> {
  if (options?.cache === false) return fetcher();

  const cached = readCache<T>(key);
  if (!options?.forceRefresh && cached && !cached.stale) return { data: cached.data, stale: false };

  const activeFetch = activeFetches.get(key) as Promise<CachedResult<T>> | undefined;
  if (activeFetch) return activeFetch;

  const fallback = cached ?? readCache<T>(key, { allowExpired: true });
  const fetchPromise = fetcher()
    .then((result) => {
      writeCache(key, result);
      failedFetches.delete(key);
      return result;
    })
    .catch((error) => {
      // Serving the expired copy is right; hiding that it is expired is not.
      if (fallback) {
        failedFetches.add(key);
        return { data: fallback.data, stale: true };
      }
      throw error;
    })
    .finally(() => {
      if (activeFetches.get(key) === fetchPromise) {
        activeFetches.delete(key);
      }
    });

  activeFetches.set(key, fetchPromise);
  return fetchPromise;
}

export type ScreenerCategory = "day_gainers" | "day_losers" | "most_actives";


type MarketMoversDataSource = "cloud" | "gloom";

export interface MarketMoversResult {
  quotes: ScreenerQuote[];
  source: MarketMoversDataSource;
  stale: boolean;
}

export interface PreferredMarketMoverSources {
  isCloudEligible(): boolean;
  fetchCloud(
    category: CloudMarketScreenerCategory,
    count: number,
    mode: "cache-first" | "refresh",
  ): Promise<CloudMarketResponse<CloudMarketScreenerPayload>>;
  fetchMarket(
    category: ScreenerCategory,
    count: number,
    options?: FetchCacheOptions,
  ): Promise<CachedResult<ScreenerQuote[]>>;
}

export interface TrendingSymbol {
  symbol: string;
}

export interface MarketSummaryQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

/** Unknown source fields stay unavailable; zero is a reported observation. */
export function screenerNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function screenerVolume(value: unknown): number | null {
  const number = screenerNumber(value);
  return number != null && number >= 0 ? number : null;
}

export function screenerVolumeRatio(volume: number | null, average: number | null): number | null {
  return volume != null && average != null && average > 0 ? volume / average : null;
}

/** Cross-source endpoints require explicit compatible price units. */
export function convertScreenerPriceUnit(value: number | undefined, from: string, to: string): number | undefined {
  const source = resolveCurrencyUnit(from);
  const target = resolveCurrencyUnit(to);
  return value != null && Number.isFinite(value) && source.currency && source.currency === target.currency
    ? value / source.divisor * target.divisor : undefined;
}

/** Validate numeric fields at the API boundary so absent values stay unavailable. */
export function parseScreenerResponse(data: unknown): ScreenerQuote[] {
  if (!data || typeof data !== "object" || !("quotes" in data) || !Array.isArray(data.quotes)) {
    throw new Error("Invalid market movers response");
  }
  return data.quotes.flatMap((q): ScreenerQuote[] => {
    if (!q || typeof q.symbol !== "string" || !q.symbol.trim()) return [];
    const volume = screenerVolume(q.volume);
    const avgVolume = screenerVolume(q.avgVolume);
    return [{
      symbol: q.symbol.trim(), name: typeof q.name === "string" && q.name.trim() ? q.name.trim() : q.symbol.trim(),
      price: screenerNumber(q.price), change: screenerNumber(q.change), changePercent: screenerNumber(q.changePercent),
      volume, avgVolume, volumeRatio: screenerVolumeRatio(volume, avgVolume),
      marketCap: screenerVolume(q.marketCap) ?? undefined, currency: typeof q.currency === "string" ? q.currency.trim() : "",
      fiftyTwoWeekHigh: screenerNumber(q.fiftyTwoWeekHigh) ?? undefined, fiftyTwoWeekLow: screenerNumber(q.fiftyTwoWeekLow) ?? undefined,
      dayHigh: screenerNumber(q.dayHigh) ?? undefined, dayLow: screenerNumber(q.dayLow) ?? undefined,
      previousClose: screenerNumber(q.previousClose) ?? undefined, exchange: typeof q.exchange === "string" ? q.exchange : "",
      lastUpdated: typeof q.lastUpdated === "number" && Number.isFinite(q.lastUpdated) && q.lastUpdated > 0 ? q.lastUpdated : undefined,
    }];
  });
}

export async function fetchScreenerResult(
  category: ScreenerCategory,
  count = 25,
  api: MarketScreenerApi = screenerApi,
  options?: FetchCacheOptions,
): Promise<CachedResult<ScreenerQuote[]>> {
  const load = async () => {
    const response = await api.getMarketMovers(category, count, options?.forceRefresh);
    if (!response.data) throw new Error("Invalid market movers response");
    return { data: parseScreenerResponse(response.data), stale: response.stale === true || response.data.stale === true };
  };
  if (!shouldUseCache(api, options)) return load();
  return loadCached(`screener:${category}:count=${count}`, load, options);
}

export async function fetchScreener(
  category: ScreenerCategory,
  count = 25,
  api: MarketScreenerApi = screenerApi,
  options?: FetchCacheOptions,
): Promise<ScreenerQuote[]> {
  return (await fetchScreenerResult(category, count, api, options)).data;
}

function cloudScreenerCategory(category: ScreenerCategory): CloudMarketScreenerCategory {
  if (category === "day_gainers") return "gainers";
  if (category === "day_losers") return "losers";
  return "most-active";
}

function isCloudScreenerEligible(): boolean {
  const user = apiClient.getCurrentUser();
  return apiClient.isVerified() && hasProAccess(user);
}

const defaultPreferredMarketMoverSources: PreferredMarketMoverSources = {
  isCloudEligible: isCloudScreenerEligible,
  fetchCloud: (category, count, mode) => apiClient.getCloudMarketScreener(category, count, mode),
  fetchMarket: (category, count, options) => fetchScreenerResult(category, count, undefined, options),
};

function mergeCloudScreenerItem(
  item: CloudMarketScreenerItem,
  metadata?: ScreenerQuote,
): ScreenerQuote {
  const currency = typeof item.currency === "string" ? item.currency.trim() : "";
  const directAverage = screenerNumber(item.avgVolume);
  const avgVolume = directAverage != null && directAverage > 0 ? directAverage : metadata?.avgVolume ?? null;
  const metadataPrice = (value: number | undefined) => convertScreenerPriceUnit(value, metadata?.currency ?? "", currency);
  return {
    symbol: item.symbol,
    name: item.name && item.name !== item.symbol
      ? item.name
      : metadata?.name ?? item.symbol,
    price: screenerNumber(item.price),
    change: screenerNumber(item.change),
    changePercent: screenerNumber(item.changePercent),
    volume: screenerVolume(item.volume),
    avgVolume,
    volumeRatio: screenerVolumeRatio(screenerVolume(item.volume), avgVolume),
    marketCap: metadata?.marketCap,
    currency,
    fiftyTwoWeekHigh: screenerNumber(item.high52w) ?? metadataPrice(metadata?.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: screenerNumber(item.low52w) ?? metadataPrice(metadata?.fiftyTwoWeekLow),
    dayHigh: screenerNumber(item.dayHigh) ?? metadataPrice(metadata?.dayHigh),
    dayLow: screenerNumber(item.dayLow) ?? metadataPrice(metadata?.dayLow),
    exchange: item.exchange || metadata?.exchange || "",
    lastUpdated: item.lastUpdated,
  };
}

async function bestEffortMarketMetadata(
  request: Promise<CachedResult<ScreenerQuote[]>>,
  waitMs: number,
): Promise<ScreenerQuote[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then((result) => result.data).catch(() => []),
      new Promise<ScreenerQuote[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), waitMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Screeners rank on a snapshot older than the quote fields they return, so a
 * list is re-ranked on the metric it displays. Unknown values sort last.
 */
export function rankScreenerQuotes(category: ScreenerCategory, quotes: ScreenerQuote[]): ScreenerQuote[] {
  const metric = (quote: ScreenerQuote): number | null => {
    const value = category === "most_actives" ? quote.volume : quote.changePercent;
    if (value == null || !Number.isFinite(value)) return null;
    return category === "day_losers" ? -value : value;
  };
  return [...quotes].sort((left, right) => {
    const a = metric(left);
    const b = metric(right);
    if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
    return b - a;
  });
}

export async function fetchPreferredMarketMovers(
  category: ScreenerCategory,
  count = 25,
  preferredOptions?: PreferredMoversOptions,
  sources: PreferredMarketMoverSources = defaultPreferredMarketMoverSources,
): Promise<MarketMoversResult> {
  const { metadataWaitMs = MARKET_METADATA_WAIT_MS, ...options } = preferredOptions ?? {};
  if (!sources.isCloudEligible()) {
    const result = await sources.fetchMarket(category, count, options);
    return { quotes: rankScreenerQuotes(category, result.data), source: "gloom", stale: result.stale };
  }

  const marketMetadata = sources.fetchMarket(
    category,
    Math.max(count, 50),
    options,
  );
  try {
    const response = await sources.fetchCloud(
      cloudScreenerCategory(category),
      count,
      options?.forceRefresh ? "refresh" : "cache-first",
    );
    if (
      (response.status === "success" || response.status === "partial")
      && response.data
      && response.data.items.length > 0
    ) {
      const metadata = await bestEffortMarketMetadata(marketMetadata, metadataWaitMs);
      const metadataBySymbol = new Map(metadata.map((quote) => [quote.symbol, quote]));
      return {
        quotes: rankScreenerQuotes(category, response.data.items.map((item) => (
          mergeCloudScreenerItem(item, metadataBySymbol.get(item.symbol))
        ))),
        source: "cloud",
        stale: response.stale === true || response.data.stale === true,
      };
    }
  } catch {
    // The public backend snapshot remains available when live rankings fail.
  }

  const fallback = await marketMetadata;
  return {
    quotes: rankScreenerQuotes(category, fallback.data),
    source: "gloom",
    stale: fallback.stale,
  };
}

export function parseTrendingResponse(data: unknown): TrendingSymbol[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap(q => q && typeof q.symbol === "string" && q.symbol.trim() ? [{ symbol: q.symbol.trim() }] : []);
}

export async function fetchTrending(
  count = 25,
  api: MarketScreenerApi = screenerApi,
  options?: FetchCacheOptions,
): Promise<TrendingSymbol[]> {
  const load = async () => {
    const response = await (api.getMarketTrending ?? apiClient.getMarketTrending)(count);
    if (response.status === "empty") return { data: [], stale: response.stale === true };
    if (!response.data) throw new Error("Market trends unavailable");
    return { data: parseTrendingResponse(response.data), stale: response.stale === true };
  };
  if (!shouldUseCache(api, options)) return (await load()).data;
  return (await loadCached(`trending:US:count=${count}`, load, options)).data;
}

export const MARKET_SUMMARY_SYMBOLS = ["^GSPC", "^DJI", "^IXIC", "^RUT"] as const;
