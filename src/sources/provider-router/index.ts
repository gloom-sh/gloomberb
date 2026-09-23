import type { PriceHistoryResult } from "../../types/price-history";
import type { ResourceStore } from "../../data/resource-store";
import type { ConnectionHealthRegistry } from "../../core/connection-health";
import type { PluginRegistry } from "../../plugins/registry";
import type { BrokerAdapter } from "../../types/broker";
import type { AppConfig } from "../../types/config";
import { createDefaultConfig } from "../../types/config";
import type {
  CachedAssetArgs,
  CachedAssetMethod,
  CachedFinancialsTarget,
  DataProvider,
  MarketDataRequestContext,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  SearchRequestContext,
  SecFilingItem,
  TickerFinancialsBatchResult,
} from "../../types/data-provider";
import type { CapabilityRouteSource } from "../../types/capability-route-source";
import { routeSourcePriority } from "../../types/capability-route-source";
import type { AnalystResearchData, CorporateActionsData, HolderData, OptionsChain, PricePoint, Quote, QuoteMetadata, TickerFinancials } from "../../types/financials";
import { mergeQuoteMetadata, quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../../market-data/quotes/metadata";
import type { NewsArticle, NewsQuery } from "../../news/types";
import type { BrokerContractRef, InstrumentSearchResult } from "../../types/instrument";
import type { TimeRange } from "../../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../../time-series/resolution";
import { debugLog } from "../../utils/debug-log";
import { ProviderRouterBatchRoutes } from "./batches";
import { mapListingTargets, publicListingExchange } from "../listing-target";
import { ProviderRouterCachedRoutes } from "./cached-routes";
import { ProviderRouterFinancialRoutes } from "./financial-routes";
import { ProviderRouterHistoryRoutes } from "./history";
import { ProviderRouterNewsRoutes } from "./news";
import { ProviderRouterPrimaryRoutes } from "./primary";
import { ProviderRouterSupplementalRoutes } from "./supplemental";
import { ProviderRouterStreamingRoutes } from "./streaming";
import {
  cacheRouterResource,
  getRouterEntityKey,
  getTickerVariantCandidates,
  resolveCachePolicy,
  type ProviderRouterCachePolicyKey,
} from "./cache";
import { ProviderRouterSearchRoutes } from "./search";
import { collectCapabilityRouteSources, normalizeRouteSource } from "./sources";
import type { ProviderRouterCoreDeps } from "./route-types";
import { withProviderConnectionHealth } from "./connection-health";
import {
  contextFromCachedTarget,
  getBrokerCandidates,
  getBrokerCandidatesForContext,
  hasBrokerContext,
  hasCachedTargetBrokerContext,
  withBrokerTimeout,
  type BrokerCandidate,
} from "./brokers";

const providerLog = debugLog.createLogger("asset-data-router");

export class AssetDataRouter implements DataProvider {
  readonly id = "asset-data-router";
  readonly name = "Asset Data Router";
  readonly priority = Number.MAX_SAFE_INTEGER;

  private registry: PluginRegistry | null = null;
  private getConfigFn: () => AppConfig = () => createDefaultConfig("");
  private readonly fallbackSource: CapabilityRouteSource | null;
  private readonly extraSources: CapabilityRouteSource[];
  private readonly batchRoutes: ProviderRouterBatchRoutes;
  private readonly historyRoutes: ProviderRouterHistoryRoutes;
  private readonly newsRoutes: ProviderRouterNewsRoutes;
  private readonly primaryRoutes: ProviderRouterPrimaryRoutes;
  private readonly searchRoutes: ProviderRouterSearchRoutes;
  private readonly streamingRoutes: ProviderRouterStreamingRoutes;
  private readonly supplementalRoutes: ProviderRouterSupplementalRoutes;
  private readonly financialRoutes: ProviderRouterFinancialRoutes;
  private readonly cachedRoutes: ProviderRouterCachedRoutes;
  private readonly healthyProviders = new WeakMap<DataProvider, DataProvider>();
  /** A short-lived process exits before a background refresh can land, so it must await stale entries. */
  private revalidateInBackground = true;

  constructor(
    fallbackSource: CapabilityRouteSource | DataProvider | null = null,
    extraSources: Array<CapabilityRouteSource | DataProvider> = [],
    private readonly resources?: ResourceStore,
    private readonly connectionHealth?: ConnectionHealthRegistry,
  ) {
    this.fallbackSource = fallbackSource ? normalizeRouteSource(fallbackSource) : null;
    this.extraSources = extraSources.map(normalizeRouteSource);
    const routeDeps = this.createRouteDeps();
    this.primaryRoutes = new ProviderRouterPrimaryRoutes(routeDeps);
    this.financialRoutes = new ProviderRouterFinancialRoutes({
      ...routeDeps,
      primaryRoutes: this.primaryRoutes,
    });
    this.cachedRoutes = new ProviderRouterCachedRoutes(routeDeps);
    this.batchRoutes = new ProviderRouterBatchRoutes({
      ...routeDeps,
      readCachedMergedFinancialsSelection: (ticker, exchange, context, allowExpired) => (
        this.financialRoutes.readCachedMergedFinancialsSelection(ticker, exchange, context, allowExpired)
      ),
      contextFromCachedTarget: (target) => this.contextFromCachedTarget(target),
      hasBrokerContext: (context) => this.hasBrokerContext(context),
      hasCachedTargetBrokerContext: (target) => this.hasCachedTargetBrokerContext(target),
      getQuote: (ticker, exchange, context) => this.financialRoutes.getQuote(ticker, exchange, context),
      getTickerFinancials: (ticker, exchange, context) => this.financialRoutes.getTickerFinancials(ticker, exchange, context),
    });
    this.historyRoutes = new ProviderRouterHistoryRoutes(routeDeps);
    this.newsRoutes = new ProviderRouterNewsRoutes({
      newsSourcesInPriorityOrder: () => this.newsSourcesInPriorityOrder(),
      logProviderError: (message) => providerLog.error(message),
    });
    this.searchRoutes = new ProviderRouterSearchRoutes({
      getBrokerCandidates: (preferredBrokerInstanceId, preferredBrokerId) => this.getBrokerCandidates(preferredBrokerInstanceId, preferredBrokerId),
      providersInPriorityOrder: () => this.providersInPriorityOrder(),
      logProviderError: (message) => providerLog.error(message),
    });
    this.streamingRoutes = new ProviderRouterStreamingRoutes({
      providersInPriorityOrder: () => this.providersInPriorityOrder(),
      getBrokerCandidatesForContext: (context, includeFallbackInstances) => this.getBrokerCandidatesForContext(context, includeFallbackInstances),
      hasBrokerContext: (context) => this.hasBrokerContext(context),
      brokerSourceKey: (candidate) => this.brokerSourceKey(candidate),
      logInfo: (message, data) => providerLog.info(message, data),
      logWarn: (message, data) => providerLog.warn(message, data),
    });
    this.supplementalRoutes = new ProviderRouterSupplementalRoutes(routeDeps);
  }

  private createRouteDeps(): ProviderRouterCoreDeps {
    return {
      resources: this.resources,
      getEntityKey: (ticker, instrument) => this.getEntityKey(ticker, instrument),
      getTickerVariantCandidates: (exchange) => this.getTickerVariantCandidates(exchange),
      getBrokerCandidatesForContext: (context, includeFallbackInstances) => this.getBrokerCandidatesForContext(context, includeFallbackInstances),
      getProviderSourceKeys: () => this.getProviderSourceKeys(),
      providersInPriorityOrder: () => this.providersInPriorityOrder(),
      brokerSourceKey: (candidate) => this.brokerSourceKey(candidate),
      providerSourceKey: (provider) => this.providerSourceKey(provider),
      resolveBrokerPolicy: (key, broker) => this.resolveBrokerPolicy(key, broker),
      resolveProviderPolicy: (key, provider) => this.resolveProviderPolicy(key, provider),
      cacheResource: (kind, entityKey, variantKey, sourceKey, value, cachePolicy) => {
        this.cacheResource(kind, entityKey, variantKey, sourceKey, value, cachePolicy);
      },
      logProviderError: (message) => providerLog.error(message),
    };
  }

  attachRegistry(registry: PluginRegistry): void {
    this.registry = registry;
  }

  setConfigAccessor(getConfig: () => AppConfig): void {
    this.getConfigFn = getConfig;
  }

  async canProvide(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<boolean> {
    const brokerQuote = await withBrokerTimeout(this.primaryRoutes.fetchBrokerQuote(ticker, exchange, context));
    if (brokerQuote) return true;
    for (const provider of this.providersInPriorityOrder()) {
      try {
        if (!provider.canProvide || await provider.canProvide(ticker, exchange, context)) {
          return true;
        }
      } catch {
        // continue through provider chain
      }
    }
    return false;
  }

  getCachedFinancialsForTargets(
    targets: CachedFinancialsTarget[],
    options: { allowExpired?: boolean; includeStaleQuotes?: boolean } = {},
  ): Map<string, TickerFinancials> {
    const { valid } = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, contextFromCachedTarget(target)));
    return this.financialRoutes.getCachedFinancialsForTargets(valid, options);
  }

  getCachedExchangeRates(currencies: string[], options: { allowExpired?: boolean } = {}): Map<string, number> {
    return this.cachedRoutes.getCachedExchangeRates(currencies, options);
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QuoteBatchResult[]> {
    const mapped = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, target.context));
    const results = await this.batchRoutes.getQuotesBatch(mapped.valid, options);
    const restored = new Map(results.map((result) => {
      const target = mapped.original(result.target);
      return [target, { ...result, target }] as const;
    }));
    for (const failure of mapped.invalid) restored.set(failure.target, { ...failure, quote: null });
    return targets.map((target) => restored.get(target) ?? { target, quote: null });
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    const mapped = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, contextFromCachedTarget(target)));
    const results = await this.batchRoutes.getTickerFinancialsBatch(mapped.valid, options);
    const restored = new Map(results.map((result) => {
      const target = mapped.original(result.target);
      return [target, { ...result, target }] as const;
    }));
    for (const failure of mapped.invalid) restored.set(failure.target, { ...failure, financials: null });
    return targets.map((target) => restored.get(target) ?? { target, financials: null });
  }

  async getTickerFinancials(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<TickerFinancials> {
    exchange = this.resolvePublicExchange(ticker, exchange, context);
    return this.financialRoutes.getTickerFinancials(ticker, exchange, context);
  }

  async getQuote(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<Quote> {
    exchange = this.resolvePublicExchange(ticker, exchange, context);
    return this.financialRoutes.getQuote(ticker, exchange, context);
  }

  async getQuoteMetadata(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<QuoteMetadata | null> {
    exchange = this.resolvePublicExchange(ticker, exchange, context);
    const cached = this.getCachedFinancialsForTargets([{ ...context, symbol: ticker, exchange }], { allowExpired: true, includeStaleQuotes: true })
      .get(ticker.trim().toUpperCase());
    const stored = cached?.quote ? quoteMetadataFromQuote(cached.quote) : cached?.quoteMetadata;
    let known = stored && quoteMetadataMatchesTarget(stored, ticker, exchange) ? stored : undefined;
    if (known?.currency && known.instrumentType) return known;
    for (const provider of this.providersInPriorityOrder()) {
      try {
        const metadata = provider.getQuoteMetadata
          ? await provider.getQuoteMetadata(ticker, exchange, context)
          : quoteMetadataFromQuote(await provider.getQuote(ticker, exchange, context));
        if (metadata && (metadata.currency || metadata.instrumentType) && quoteMetadataMatchesTarget(metadata, ticker, exchange)) {
          known = mergeQuoteMetadata(known, metadata);
          if (known?.currency && known.instrumentType) return known;
        }
      } catch { /* Optional listing metadata must not prevent historical research. */ }
    }
    return known ?? null;
  }

  setBackgroundRevalidation(enabled: boolean): void {
    this.revalidateInBackground = enabled;
  }

  async getExchangeRate(fromCurrency: string, context?: Pick<MarketDataRequestContext, "cacheMode">): Promise<number> {
    return (await this.getCachedQuery("getExchangeRate", [fromCurrency]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  async search(query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]> {
    return this.searchRoutes.search(query, context);
  }

  async getNews(query: NewsQuery): Promise<NewsArticle[]> {
    return this.newsRoutes.getNews(query);
  }

  async getHolders(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<HolderData> {
    return (await this.getCachedQuery("getHolders", [ticker, exchange, context]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  async getAnalystResearch(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<AnalystResearchData> {
    return (await this.getCachedQuery("getAnalystResearch", [ticker, exchange, context]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  async getCorporateActions(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<CorporateActionsData> {
    return (await this.getCachedQuery("getCorporateActions", [ticker, exchange, context]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  async getEarningsCalendar(symbols: string[], context?: MarketDataRequestContext) {
    return this.supplementalRoutes.getEarningsCalendar(symbols, context);
  }

  async getSecFilings(ticker: string, count = 15, exchange?: string, context?: MarketDataRequestContext): Promise<SecFilingItem[]> {
    return (await this.getCachedQuery("getSecFilings", [ticker, count, exchange, context]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  async getSecFilingDocuments(filing: SecFilingItem) {
    return (await this.getCachedQuery("getSecFilingDocuments", [filing]).load({ force: false, background: this.revalidateInBackground })).value;
  }

  async getSecFilingContent(filing: SecFilingItem): Promise<string | null> {
    return (await this.getCachedQuery("getSecFilingContent", [filing]).load({ force: false, background: this.revalidateInBackground })).value;
  }

  async getArticleSummary(url: string): Promise<string | null> {
    return (await this.getCachedQuery("getArticleSummary", [url]).load({ force: false, background: this.revalidateInBackground })).value;
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getPriceHistory(ticker, exchange, range, context);
  }

  async getPriceHistoryWithMetadata(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PriceHistoryResult> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getPriceHistoryWithMetadata(ticker, exchange, range, context);
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getPriceHistoryForResolution(ticker, exchange, bufferRange, resolution, context);
  }

  async getPriceHistoryForResolutionWithMetadata(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getPriceHistoryForResolutionWithMetadata(ticker, exchange, bufferRange, resolution, context);
  }

  async getChartResolutionSupport(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ChartResolutionSupport[]> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getChartResolutionSupport(ticker, exchange, context);
  }

  async getChartResolutionCapabilities(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ManualChartResolution[]> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getChartResolutionCapabilities(ticker, exchange, context);
  }

  async getDetailedPriceHistory(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getDetailedPriceHistory(ticker, exchange, startDate, endDate, barSize, context);
  }

  async getDetailedPriceHistoryWithMetadata(
    ticker: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
    barSize: string,
    context?: MarketDataRequestContext,
  ): Promise<PriceHistoryResult> {
    exchange = this.resolvePublicExchange(ticker, exchange, context) ?? "";
    return this.historyRoutes.getDetailedPriceHistoryWithMetadata(ticker, exchange, startDate, endDate, barSize, context);
  }

  async getOptionsChain(ticker: string, exchange?: string, expirationDate?: number, context?: MarketDataRequestContext): Promise<OptionsChain> {
    return (await this.getCachedQuery("getOptionsChain", [ticker, exchange, expirationDate, context]).load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground })).value;
  }

  getCachedQuery<K extends CachedAssetMethod>(method: K, args: CachedAssetArgs<K>) {
    return this.cachedRoutes.get(method, args);
  }

  private resolvePublicExchange(ticker: string, exchange?: string, context?: MarketDataRequestContext): string | undefined {
    return hasBrokerContext(context) || context?.instrument ? exchange : publicListingExchange(ticker, exchange);
  }

  private getEntityKey(ticker: string, instrument?: BrokerContractRef | null): string {
    return getRouterEntityKey(ticker, instrument);
  }

  private getTickerVariantCandidates(exchange?: string): string[] {
    return getTickerVariantCandidates(exchange);
  }

  private providerSourceKey(provider: DataProvider): string {
    return `provider:${provider.id}`;
  }

  private brokerSourceKey(candidate: BrokerCandidate): string {
    return `broker:${candidate.brokerId}:${candidate.brokerInstanceId}`;
  }

  private getProviderSourceKeys(): string[] {
    return this.providersInPriorityOrder().map((provider) => this.providerSourceKey(provider));
  }

  private resolveProviderPolicy(key: ProviderRouterCachePolicyKey, provider: DataProvider) {
    return resolveCachePolicy(provider.cachePolicy, key);
  }

  private resolveBrokerPolicy(key: ProviderRouterCachePolicyKey, broker: BrokerAdapter) {
    return resolveCachePolicy(broker.cachePolicy, key);
  }

  private cacheResource<T>(
    kind: string,
    entityKey: string,
    variantKey: string,
    sourceKey: string,
    value: T,
    cachePolicy: ReturnType<typeof resolveCachePolicy>,
  ): void {
    cacheRouterResource(this.resources, kind, entityKey, variantKey, sourceKey, value, cachePolicy);
  }

  private getBrokerCandidates(
    preferredBrokerInstanceId?: string,
    preferredBrokerId?: string,
    includeFallbackInstances = true,
  ): BrokerCandidate[] {
    return getBrokerCandidates(
      this.registry,
      this.getConfigFn(),
      preferredBrokerInstanceId,
      preferredBrokerId,
      includeFallbackInstances,
    );
  }

  private getBrokerCandidatesForContext(
    context?: MarketDataRequestContext,
    includeFallbackInstances = true,
  ): BrokerCandidate[] {
    return getBrokerCandidatesForContext(this.registry, this.getConfigFn(), context, includeFallbackInstances);
  }

  private hasBrokerContext(context?: MarketDataRequestContext): boolean {
    return hasBrokerContext(context);
  }

  private hasCachedTargetBrokerContext(target: CachedFinancialsTarget): boolean {
    return hasCachedTargetBrokerContext(target);
  }

  private contextFromCachedTarget(target: CachedFinancialsTarget): MarketDataRequestContext {
    return contextFromCachedTarget(target);
  }

  private sortedSources(): CapabilityRouteSource[] {
    const sources = [...this.extraSources];
    if (this.registry) {
      sources.push(...collectCapabilityRouteSources([
        ...this.registry.getEnabledCapabilities("asset-data"),
        ...this.registry.getEnabledCapabilities("news"),
      ]));
    }
    return sources
      .filter((source) => source.id !== this.id && source.id !== this.fallbackSource?.id)
      .sort((a, b) => routeSourcePriority(a) - routeSourcePriority(b));
  }

  private sortedProviders(): DataProvider[] {
    return this.sortedSources()
      .map((source) => source.market)
      .filter((provider): provider is DataProvider => !!provider);
  }

  /**
   * Name of the provider a plain market request reaches first: the enabled
   * capability with the best priority, or the fallback when nothing else is
   * registered. Broker-scoped requests can still route elsewhere.
   */
  primaryMarketSourceName(): string | null {
    return this.providersInPriorityOrder()[0]?.name ?? null;
  }

  private providersInPriorityOrder(): DataProvider[] {
    const providers = [...this.sortedProviders()];
    const fallbackProvider = this.fallbackSource?.market ?? null;
    if (fallbackProvider && !providers.some((provider) => provider.id === fallbackProvider.id)) {
      providers.push(fallbackProvider);
    }
    if (!this.connectionHealth) return providers;
    return providers.map((provider) => {
      const existing = this.healthyProviders.get(provider);
      if (existing) return existing;
      const wrapped = withProviderConnectionHealth(provider, this.connectionHealth!);
      this.healthyProviders.set(provider, wrapped);
      return wrapped;
    });
  }

  private newsSourcesInPriorityOrder(): CapabilityRouteSource[] {
    const sources = this.sortedSources().filter((source) => !!source.news);
    if (this.fallbackSource?.news && !sources.some((source) => source.id === this.fallbackSource?.id)) {
      sources.push(this.fallbackSource);
    }
    return sources;
  }

  subscribeQuotes(
    targets: QuoteSubscriptionTarget[],
    onQuote: (target: QuoteSubscriptionTarget, quote: Quote) => void,
  ): () => void {
    const mapped = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, target.context));
    return this.streamingRoutes.subscribeQuotes(mapped.valid, (target, quote) => onQuote(mapped.original(target), quote));
  }
}
