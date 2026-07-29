import type { ResourceStore } from "../../data/resource-store";
import type { PluginRegistry } from "../../plugins/registry";
import type { BrokerAdapter } from "../../types/broker";
import type { AppConfig } from "../../types/config";
import { createDefaultConfig } from "../../types/config";
import type {
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
import type { AnalystResearchData, CorporateActionsData, HolderData, OptionsChain, PricePoint, Quote, TickerFinancials } from "../../types/financials";
import type { NewsArticle, NewsQuery } from "../../news/types";
import type { BrokerContractRef, InstrumentSearchResult } from "../../types/instrument";
import type { TimeRange } from "../../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../../time-series/resolution";
import { debugLog } from "../../utils/debug-log";
import { ProviderRouterBatchRoutes } from "./batches";
import { ProviderRouterDocumentRoutes } from "./document-routes";
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
  private readonly documentRoutes: ProviderRouterDocumentRoutes;

  constructor(
    fallbackSource: CapabilityRouteSource | DataProvider | null = null,
    extraSources: Array<CapabilityRouteSource | DataProvider> = [],
    private readonly resources?: ResourceStore,
  ) {
    this.fallbackSource = fallbackSource ? normalizeRouteSource(fallbackSource) : null;
    this.extraSources = extraSources.map(normalizeRouteSource);
    const routeDeps = this.createRouteDeps();
    this.primaryRoutes = new ProviderRouterPrimaryRoutes(routeDeps);
    this.financialRoutes = new ProviderRouterFinancialRoutes({
      ...routeDeps,
      primaryRoutes: this.primaryRoutes,
    });
    this.documentRoutes = new ProviderRouterDocumentRoutes(routeDeps);
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
    return this.financialRoutes.getCachedFinancialsForTargets(targets, options);
  }

  getCachedExchangeRates(currencies: string[], options: { allowExpired?: boolean } = {}): Map<string, number> {
    return this.supplementalRoutes.getCachedExchangeRates(currencies, options);
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QuoteBatchResult[]> {
    return this.batchRoutes.getQuotesBatch(targets, options);
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    return this.batchRoutes.getTickerFinancialsBatch(targets, options);
  }

  async getTickerFinancials(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<TickerFinancials> {
    return this.financialRoutes.getTickerFinancials(ticker, exchange, context);
  }

  async getQuote(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<Quote> {
    return this.financialRoutes.getQuote(ticker, exchange, context);
  }

  async getExchangeRate(fromCurrency: string): Promise<number> {
    return this.supplementalRoutes.getExchangeRate(fromCurrency);
  }

  async search(query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]> {
    return this.searchRoutes.search(query, context);
  }

  async getNews(query: NewsQuery): Promise<NewsArticle[]> {
    return this.newsRoutes.getNews(query);
  }

  async getHolders(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<HolderData> {
    return this.supplementalRoutes.getHolders(ticker, exchange, context);
  }

  async getAnalystResearch(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<AnalystResearchData> {
    return this.supplementalRoutes.getAnalystResearch(ticker, exchange, context);
  }

  async getCorporateActions(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<CorporateActionsData> {
    return this.supplementalRoutes.getCorporateActions(ticker, exchange, context);
  }

  async getEarningsCalendar(symbols: string[], context?: MarketDataRequestContext) {
    return this.supplementalRoutes.getEarningsCalendar(symbols, context);
  }

  async getSecFilings(ticker: string, count = 15, exchange?: string, context?: MarketDataRequestContext): Promise<SecFilingItem[]> {
    return this.documentRoutes.getSecFilings(ticker, count, exchange, context);
  }

  async getSecFilingDocuments(filing: SecFilingItem) {
    return this.documentRoutes.getSecFilingDocuments(filing);
  }

  async getSecFilingContent(filing: SecFilingItem): Promise<string | null> {
    return this.documentRoutes.getSecFilingContent(filing);
  }

  async getArticleSummary(url: string): Promise<string | null> {
    return this.documentRoutes.getArticleSummary(url);
  }

  async getPriceHistory(ticker: string, exchange: string, range: TimeRange, context?: MarketDataRequestContext): Promise<PricePoint[]> {
    return this.historyRoutes.getPriceHistory(ticker, exchange, range, context);
  }

  async getPriceHistoryForResolution(
    ticker: string,
    exchange: string,
    bufferRange: TimeRange,
    resolution: ManualChartResolution,
    context?: MarketDataRequestContext,
  ): Promise<PricePoint[]> {
    return this.historyRoutes.getPriceHistoryForResolution(ticker, exchange, bufferRange, resolution, context);
  }

  async getChartResolutionSupport(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ChartResolutionSupport[]> {
    return this.historyRoutes.getChartResolutionSupport(ticker, exchange, context);
  }

  async getChartResolutionCapabilities(
    ticker: string,
    exchange?: string,
    context?: MarketDataRequestContext,
  ): Promise<ManualChartResolution[]> {
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
    return this.historyRoutes.getDetailedPriceHistory(ticker, exchange, startDate, endDate, barSize, context);
  }

  async getOptionsChain(ticker: string, exchange?: string, expirationDate?: number, context?: MarketDataRequestContext): Promise<OptionsChain> {
    return this.supplementalRoutes.getOptionsChain(ticker, exchange, expirationDate, context);
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

  private providersInPriorityOrder(): DataProvider[] {
    const providers = [...this.sortedProviders()];
    const fallbackProvider = this.fallbackSource?.market ?? null;
    if (fallbackProvider && !providers.some((provider) => provider.id === fallbackProvider.id)) {
      providers.push(fallbackProvider);
    }
    return providers;
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
    return this.streamingRoutes.subscribeQuotes(targets, onQuote);
  }
}
