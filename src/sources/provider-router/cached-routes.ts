import { CachedQuery, type CachedValue } from "../../data/cached-query";
import type { CachedAssetArgs, CachedAssetMethod, CachedAssetValue, DataProvider, MarketDataRequestContext, SecFilingItem } from "../../types/data-provider";
import type { AnalystResearchData, CorporateActionsData, HolderData } from "../../types/financials";
import { canonicalExchange } from "../../utils/exchanges";
import { shouldLogProviderError } from "../provider-errors";
import { withBrokerTimeout } from "./brokers";
import { buildVariantKey, compactUrl, listCachedResources, resolveCachePolicy, type ProviderRouterCachePolicyKey } from "./cache";
import { hasAnalystResearchValue, hasCorporateActionsValue, isAnalystResearchMissingRatingTargets } from "./financials";
import type { ProviderRouterCoreDeps } from "./route-types";

interface Route {
  kind: string;
  policy: ProviderRouterCachePolicyKey;
  entityKey: string;
  variants: string[];
  request: (provider: DataProvider, force: boolean) => Promise<unknown> | undefined;
  error: string;
  rank?: (value: any) => number;
  acceptCached?: (value: any) => boolean;
  decode?: (value: any) => unknown;
  metadata?: (value: any) => Partial<CachedValue<unknown>>;
  encode?: (value: any) => unknown;
  empty?: () => unknown;
  throwLastError?: boolean;
  brokerRequest?: { ticker: string; exchange?: string; expiration?: number; context?: MarketDataRequestContext };
}

/** One query owns both persisted source selection and live refreshes for a resource. */
export class ProviderRouterCachedRoutes {
  private readonly objectIds = new WeakMap<object, number>();
  private nextObjectId = 0;
  private readonly queries = new Map<string, CachedQuery<any>>();

  constructor(private readonly deps: ProviderRouterCoreDeps) {}

  get<K extends CachedAssetMethod>(method: K, args: CachedAssetArgs<K>): CachedQuery<CachedAssetValue<K>> {
    const route = this.describe(method, args);
    const providers = this.deps.providersInPriorityOrder();
    const brokers = route.brokerRequest
      ? this.deps.getBrokerCandidatesForContext(route.brokerRequest.context, false)
      : [];
    const sourceKeys = [...brokers.map(this.deps.brokerSourceKey), ...providers.map(this.deps.providerSourceKey)];
    // Source order and broker instance are part of query identity: disabling a source
    // or changing accounts must never reuse the previous route's memory result.
    const objectId = (value: object) => {
      if (!this.objectIds.has(value)) this.objectIds.set(value, ++this.nextObjectId);
      return this.objectIds.get(value);
    };
    const key = JSON.stringify([method, route.entityKey, route.variants, sourceKeys,
      providers.map(objectId), brokers.map(({ broker, instance }) => [objectId(broker), objectId(instance)])]);
    const existing = this.queries.get(key);
    if (existing) return existing;
    const staticUsd = method === "getExchangeRate" && route.entityKey === "USD/USD";
    const read = (allowExpired: boolean): CachedValue<unknown> | null => {
      if (staticUsd) return { value: 1, fetchedAt: 0, staleAt: Infinity, expiresAt: Infinity, source: "static" };
      const records = listCachedResources<unknown>(this.deps.resources, route.kind, route.entityKey, route.variants, sourceKeys, allowExpired)
        .filter((record) => (route.rank?.(record.value) ?? 0) >= 0)
        .map((record) => ({ ...record, value: route.decode ? route.decode(record.value) : record.value, metadata: route.metadata?.(record.value) }));
      const record = (route.acceptCached ? records.find((entry) => route.acceptCached!(entry.value)) : null) ?? records[0];
      if (!record) return null;
      return {
        value: record.value,
        fetchedAt: record.fetchedAt, staleAt: record.staleAt, expiresAt: record.expiresAt,
        source: record.sourceKey.replace(/^provider:/, ""),
        ...record.metadata,
      };
    };
    const store = (value: unknown, sourceKey: string, policy: ReturnType<ProviderRouterCoreDeps["resolveProviderPolicy"]>): CachedValue<unknown> => {
      this.deps.cacheResource(route.kind, route.entityKey, route.variants[0] ?? "", sourceKey, route.encode ? route.encode(value) : value, policy);
      const fetchedAt = Date.now();
      return { value: route.decode ? route.decode(value) : value, fetchedAt, staleAt: fetchedAt + policy.staleMs,
        expiresAt: fetchedAt + policy.expireMs, source: sourceKey.replace(/^provider:/, ""), ...route.metadata?.(value) };
    };
    const query = new CachedQuery({
      read,
      acceptCached: route.acceptCached,
      fetch: async (force) => {
        if (route.brokerRequest) {
          const { ticker, exchange, expiration, context } = route.brokerRequest;
          const brokerResult = await withBrokerTimeout((async () => {
            for (const candidate of brokers) {
              if (!candidate.broker.getOptionsChain) continue;
              try {
                const value = await candidate.broker.getOptionsChain(ticker, candidate.instance, exchange, expiration, context?.instrument ?? null);
                return store(value, this.deps.brokerSourceKey(candidate), this.deps.resolveBrokerPolicy(route.policy, candidate.broker));
              } catch { /* Try the next broker, then the provider chain. */ }
            }
            return null;
          })());
          if (brokerResult) return brokerResult;
        }
        let best: CachedValue<unknown> | null = null;
        let bestRank = -1;
        let lastError: unknown;
        for (const provider of providers) {
          try {
            const request = route.request(provider, force);
            if (!request) continue;
            const value = await request;
            const rank = route.rank?.(value) ?? 2;
            if (rank < 0) continue;
            const result = store(value, this.deps.providerSourceKey(provider), this.deps.resolveProviderPolicy(route.policy, provider));
            if (rank === 2) return result;
            if (rank > bestRank) { best = result; bestRank = rank; }
          } catch (error) {
            lastError = error;
            if (shouldLogProviderError(error)) this.deps.logProviderError(`${provider.id} failed: ${error}`);
          }
        }
        if (best) return best;
        if (route.throwLastError && lastError) throw lastError;
        if (route.empty) {
          const fetchedAt = Date.now();
          const policy = resolveCachePolicy(undefined, route.policy);
          return { value: route.empty(), fetchedAt, staleAt: fetchedAt + policy.staleMs, expiresAt: fetchedAt + policy.expireMs, source: "" };
        }
        throw new Error(route.error);
      },
    });
    this.queries.set(key, query);
    return query as CachedQuery<CachedAssetValue<K>>;
  }

  getCachedExchangeRates(currencies: string[], options: { allowExpired?: boolean } = {}): Map<string, number> {
    const results = new Map<string, number>();
    for (const currency of currencies) {
      const value = this.get("getExchangeRate", [currency]).getSnapshot().result;
      if (value && (options.allowExpired !== false || value.expiresAt > Date.now())) results.set(currency, value.value);
      else if (options.allowExpired !== false) {
        const route = this.describe("getExchangeRate", [currency]);
        const record = listCachedResources<{ rate: number }>(this.deps.resources, "exchange-rate", route.entityKey, [""], this.deps.getProviderSourceKeys(), true)
          .find((candidate) => (route.rank?.(candidate.value) ?? -1) >= 0);
        if (record) results.set(currency, record.value.rate);
      }
    }
    return results;
  }

  private describe(method: CachedAssetMethod, args: readonly unknown[]): Route {
    const [ticker, exchange, extra, context] = args as [string, string | undefined, any, MarketDataRequestContext | undefined];
    const instrumentContext = (method === "getOptionsChain" ? context : extra) as MarketDataRequestContext | undefined;
    const tickerRoute = (kind: string, policy: ProviderRouterCachePolicyKey): Pick<Route, "kind" | "policy" | "entityKey" | "variants"> => ({
      kind, policy, entityKey: this.deps.getEntityKey(ticker, instrumentContext?.instrument),
      variants: this.deps.getTickerVariantCandidates(exchange),
    });
    switch (method) {
      case "getExchangeRate": {
        const currency = ticker.trim().toUpperCase();
        return {
          kind: "exchange-rate", policy: "exchangeRate", entityKey: `${currency}/USD`, variants: [""],
          request: (provider) => provider.getExchangeRateSnapshot?.(currency) ?? provider.getExchangeRate(currency),
          rank: (value: any) => {
            const rate = typeof value === "number" ? value : value?.rate;
            return Number.isFinite(rate) && rate > 0 && (!value?.fromCurrency || value.fromCurrency === currency)
              && (!value?.toCurrency || value.toCurrency === "USD") ? 2 : -1;
          },
          decode: (data: any) => typeof data === "number" ? data : data.rate,
          encode: (data: any) => typeof data === "number" ? { rate: data } : data,
          metadata: (data: any) => {
            if (typeof data !== "object" || !data) return {};
            const finiteTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
            const fetchedAt = finiteTime(data.fetchedAt);
            const staleAt = finiteTime(data.staleAt);
            return {
              ...(fetchedAt !== undefined ? { fetchedAt, expiresAt: fetchedAt + 7 * 24 * 60 * 60_000 } : {}),
              ...(staleAt !== undefined || data.stale === true ? { staleAt: data.stale === true ? Math.min(staleAt ?? Date.now(), Date.now()) : staleAt! } : {}),
              asOf: finiteTime(data.asOf),
              ...(typeof data.source === "string" ? { source: data.source } : {}),
            };
          },
          error: `No exchange rate provider available for ${currency}`,
        };
      }
      case "getHolders": return {
        ...tickerRoute("holders", "holders"), request: (provider, force) => provider.getHolders?.(ticker, exchange, force ? { ...extra, cacheMode: "refresh" } : extra),
        rank: (data: HolderData) => data.holders.length > 0 ? 2 : 0, throwLastError: true,
        error: `No holder data provider available for ${ticker}`,
      };
      case "getAnalystResearch": return {
        ...tickerRoute("analystResearch-v2", "analystResearch"), request: (provider, force) => provider.getAnalystResearch?.(ticker, exchange, force ? { ...extra, cacheMode: "refresh" } : extra),
        rank: (data: AnalystResearchData) => !hasAnalystResearchValue(data) ? 0 : data.stale || isAnalystResearchMissingRatingTargets(data) ? 1 : 2,
        acceptCached: (data: AnalystResearchData) => !data.stale && !isAnalystResearchMissingRatingTargets(data), throwLastError: true,
        error: `No analyst research provider available for ${ticker}`,
      };
      case "getCorporateActions": return {
        ...tickerRoute("corporateActions-v2", "corporateActions"), request: (provider, force) => provider.getCorporateActions?.(ticker, exchange, force ? { ...extra, cacheMode: "refresh" } : extra),
        rank: (data: CorporateActionsData) => !hasCorporateActionsValue(data) ? 0 : data.stale || Object.values(data.coverage ?? {}).includes("unavailable") ? 1 : 2,
        acceptCached: (data: CorporateActionsData) => !data.stale && !Object.values(data.coverage ?? {}).includes("unavailable"), throwLastError: true,
        error: `No corporate actions provider available for ${ticker}`,
      };
      case "getOptionsChain": return {
        ...tickerRoute("options-chain", "optionsChain"),
        variants: [...new Set([buildVariantKey([["exchange", canonicalExchange(exchange)], ["expiration", extra ?? "default"]]), buildVariantKey([["expiration", extra ?? "default"]]), ""])],
        request: (provider, force) => provider.getOptionsChain?.(ticker, exchange, extra, force ? { ...context, cacheMode: "refresh" } : context),
        brokerRequest: { ticker, exchange, expiration: extra, context },
        error: `No options provider available for ${ticker}`,
      };
      case "getSecFilings": {
        const [symbol, count = 15, listingExchange, requestContext] = args as CachedAssetArgs<"getSecFilings">;
        return {
          kind: "sec-filings", policy: "secFilings", entityKey: this.deps.getEntityKey(symbol, requestContext?.instrument),
          variants: [...new Set([buildVariantKey([["exchange", canonicalExchange(listingExchange)], ["count", count]]), buildVariantKey([["count", count]]), ""])],
          request: (provider, force) => provider.getSecFilings?.(symbol, count, listingExchange, force ? { ...requestContext, cacheMode: "refresh" } : requestContext),
          throwLastError: true, error: `No SEC filings provider available for ${symbol}`,
        };
      }
      case "getSecFilingContent":
      case "getSecFilingDocuments": {
        const filing = args[0] as SecFilingItem;
        const content = method === "getSecFilingContent";
        return {
          kind: content ? "sec-filing-content" : "sec-filing-documents", policy: content ? "secFilingContent" : "secFilingDocuments",
          entityKey: compactUrl(content ? filing.primaryDocumentUrl ?? filing.filingUrl : filing.filingUrl), variants: [""],
          request: (provider) => content ? provider.getSecFilingContent?.(filing) : provider.getSecFilingDocuments?.(filing),
          throwLastError: true, error: `No SEC filing ${content ? "content" : "documents"} provider available`,
        };
      }
      case "getArticleSummary": return {
        kind: "article-summary", policy: "articleSummary", entityKey: compactUrl(ticker), variants: [""],
        request: (provider) => provider.getArticleSummary(ticker), rank: (value) => value == null ? -1 : 2,
        empty: () => null, error: "No article summary provider available",
      };
    }
  }
}
