import { logFailure } from "../../utils/log-failure";
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
  QuoteBatchOptions,
  QuoteBatchResult,
  QuoteSubscriptionTarget,
  SearchRequestContext,
  SecFilingItem,
  TickerFinancialsBatchResult,
} from "../../types/data-provider";
import type { CapabilityRouteSource } from "../../types/capability-route-source";
import { routeSourcePriority } from "../../types/capability-route-source";
import type { AnalystResearchData, CorporateActionsData, HolderData, OptionsChain, PricePoint, Quote, QuoteContributionMap, QuoteMetadata, TickerFinancials } from "../../types/financials";
import { datedCloseListingKey, PreviousCloseDates, type DatedCloseListing } from "../../market-data/market/dated-previous-close";
import { mergeQuoteMetadata, quoteMetadataFromQuote, quoteMetadataMatchesTarget } from "../../market-data/quotes/metadata";
import type { NewsArticle, NewsQuery } from "../../news/types";
import type { BrokerContractRef, InstrumentSearchResult } from "../../types/instrument";
import type { TickerChanges } from "../../types/ticker-changes";
import type { IssuerListings } from "../../types/issuer-listings";
import type { TimeRange } from "../../time-series/range";
import type { ChartResolutionSupport, ManualChartResolution } from "../../time-series/resolution";
import { debugLog } from "../../utils/debug-log";
import { errorMessage } from "../../utils/errors";
import { ProviderRouterBatchRoutes } from "./batches";
import { createSignedInRealtimeCloudAccess, type RealtimeCloudAccess } from "./realtime-access";
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

/**
 * How long a short-lived process (the CLI) waits in all, per request that
 * prints what its moves are from, for the daily closes that date them. The
 * long-lived app never waits: it answers with what was read and dates the
 * copies after.
 */
const CHANGE_BASIS_WAIT_MS = 2_500;

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
  private realtimeCloudAccess: RealtimeCloudAccess = createSignedInRealtimeCloudAccess();
  /** A short-lived process exits before a background refresh can land, so it must await stale entries. */
  private revalidateInBackground = true;
  /**
   * Every quote this router answers names the day its previous close is from,
   * where the venue's calendar cannot. The closes come from the providers
   * alone, the chart's month of them shared: a broker is never asked once
   * per listing. A read that lands dates the latest copy for its listing's
   * stream subscribers.
   */
  private readonly previousCloseDates = new PreviousCloseDates(
    (listing) => this.historyRoutes.getPriceHistory(listing.symbol, listing.exchange, "1M", listingHistoryContext(listing.context), { askBrokers: false }),
    { onDated: (listing, quote) => { for (const listener of this.datedQuoteListeners.get(datedCloseListingKey(listing)) ?? []) listener(quote); } },
  );
  private readonly datedQuoteListeners = new Map<string, Set<(quote: Quote) => void>>();

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
    this.historyRoutes = new ProviderRouterHistoryRoutes({ ...routeDeps, revalidatesInBackground: () => this.revalidateInBackground });
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
      hasRealtimeCloudAccess: () => this.realtimeCloudAccess.has(),
      subscribeRealtimeCloudAccess: (listener) => this.realtimeCloudAccess.subscribe?.(listener) ?? (() => {}),
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

  /** Replaces the signed-in plan check that decides when cloud quotes beat a delayed broker. */
  setRealtimeCloudAccess(access: RealtimeCloudAccess): void {
    this.realtimeCloudAccess = access;
  }

  async canProvide(ticker: string, exchange?: string, context?: MarketDataRequestContext): Promise<boolean> {
    const brokerQuote = await withBrokerTimeout(this.primaryRoutes.fetchBrokerQuote(ticker, exchange, context));
    if (brokerQuote) return true;
    for (const provider of this.providersInPriorityOrder()) {
      try {
        if (!provider.canProvide || await provider.canProvide(ticker, exchange, context)) {
          return true;
        }
      } catch (error) {
        logFailure("sources.provider-router.index", "Checking provider availability failed")(error);
      }
    }
    return false;
  }

  getCachedFinancialsForTargets(
    targets: CachedFinancialsTarget[],
    options: { allowExpired?: boolean; includeStaleQuotes?: boolean } = {},
  ): Map<string, TickerFinancials> {
    const { valid } = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, contextFromCachedTarget(target)));
    const cached = this.financialRoutes.getCachedFinancialsForTargets(valid, options);
    for (const target of valid) {
      const key = target.symbol.toUpperCase();
      const financials = cached.get(key);
      if (financials) cached.set(key, this.knownFinancials(financials, listingOf(target, contextFromCachedTarget(target))));
    }
    return cached;
  }

  getCachedExchangeRates(currencies: string[], options: { allowExpired?: boolean } = {}): Map<string, number> {
    return this.cachedRoutes.getCachedExchangeRates(currencies, options);
  }

  async getQuotesBatch(
    targets: QuoteSubscriptionTarget[],
    options: QuoteBatchOptions = {},
  ): Promise<QuoteBatchResult[]> {
    const mapped = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, target.context));
    const answered = await this.batchRoutes.getQuotesBatch(mapped.valid, withoutDating(options));
    const quoted = answered.flatMap((result) => result.quote ? [{ quote: result.quote, listing: listingOf(result.target, result.target.context) }] : []);
    // A cache-only answer never reaches the network, so it is dated only by what was read already.
    const dated = options.cacheOnly
      ? quoted.map(({ quote, listing }) => this.previousCloseDates.known(quote, listing))
      : await this.datedAnswers(quoted, options.datesChangeBasis, options.signal);
    let next = 0;
    const results = answered.map((result) => {
      if (!result.quote) return result;
      const quote = dated[next++]!;
      return quote === result.quote ? result : { ...result, quote };
    });
    const restored = new Map<QuoteSubscriptionTarget, QuoteBatchResult>(results.map((result) => {
      const target = mapped.original(result.target);
      return [target, { ...result, target }] as const;
    }));
    for (const failure of mapped.invalid) restored.set(failure.target, { ...failure, quote: null });
    // Batches cross the desktop and screenshot bridges as JSON, which turns an
    // Error into {} and its reason into "[object Object]" on the board.
    return targets.map((target) => {
      const result = restored.get(target) ?? { target, quote: null };
      return result.error == null ? result : { ...result, error: errorMessage(result.error) };
    });
  }

  async getTickerFinancialsBatch(
    targets: CachedFinancialsTarget[],
    options: { forceRefresh?: boolean; datesChangeBasis?: boolean } = {},
  ): Promise<TickerFinancialsBatchResult[]> {
    const mapped = mapListingTargets(targets, (target) => this.resolvePublicExchange(target.symbol, target.exchange, contextFromCachedTarget(target)));
    const answered = await this.batchRoutes.getTickerFinancialsBatch(mapped.valid, { forceRefresh: options.forceRefresh });
    const listingOfResult = (result: TickerFinancialsBatchResult) => listingOf(result.target, contextFromCachedTarget(result.target));
    const quoted = answered.flatMap((result) => result.financials?.quote ? [{ quote: result.financials.quote, listing: listingOfResult(result) }] : []);
    const dated = await this.datedAnswers(quoted, options.datesChangeBasis);
    let next = 0;
    const results = answered.map((result) => {
      if (!result.financials?.quote) return result;
      const financials = this.withDatedQuote(result.financials, dated[next++]!, listingOfResult(result));
      return financials === result.financials ? result : { ...result, financials };
    });
    const restored = new Map(results.map((result) => {
      const target = mapped.original(result.target);
      return [target, { ...result, target }] as const;
    }));
    for (const failure of mapped.invalid) restored.set(failure.target, { ...failure, financials: null });
    return targets.map((target) => restored.get(target) ?? { target, financials: null });
  }

  async getTickerFinancials(ticker: string, exchange?: string, requestContext?: MarketDataRequestContext): Promise<TickerFinancials> {
    const { context, datesChangeBasis } = splitDating(requestContext);
    exchange = this.resolvePublicExchange(ticker, exchange, context);
    const financials = await this.financialRoutes.getTickerFinancials(ticker, exchange, context);
    if (!financials.quote) return financials;
    const listing = listingOf({ symbol: ticker, exchange }, context);
    const [quote] = await this.datedAnswers([{ quote: financials.quote, listing }], datesChangeBasis);
    return this.withDatedQuote(financials, quote!, listing);
  }

  async getQuote(ticker: string, exchange?: string, requestContext?: MarketDataRequestContext): Promise<Quote> {
    const { context, datesChangeBasis } = splitDating(requestContext);
    exchange = this.resolvePublicExchange(ticker, exchange, context);
    const quote = await this.financialRoutes.getQuote(ticker, exchange, context);
    return (await this.datedAnswers([{ quote, listing: listingOf({ symbol: ticker, exchange }, context) }], datesChangeBasis))[0]!;
  }

  /**
   * The quotes as this router answers them, their previous closes dated
   * (PreviousCloseDates). The long-lived app never waits: each is dated by
   * what was read already, and the reads it lacks start for the copies after
   * it. A short-lived process starts reads only for a request that prints
   * what its moves are from (`datesChangeBasis`), and waits for them a few
   * seconds in all.
   */
  private async datedAnswers(
    entries: Array<{ quote: Quote; listing: DatedCloseListing }>,
    datesChangeBasis?: boolean,
    signal?: AbortSignal,
  ): Promise<Quote[]> {
    if (this.revalidateInBackground) return entries.map(({ quote, listing }) => this.previousCloseDates.observe(quote, listing));
    if (datesChangeBasis) await this.previousCloseDates.settle(entries, { waitMs: CHANGE_BASIS_WAIT_MS, signal });
    return entries.map(({ quote, listing }) => this.previousCloseDates.known(quote, listing));
  }

  /** The financials with their dated quote, and the contributions it is resolved from dated alike. */
  private withDatedQuote(financials: TickerFinancials, quote: Quote, listing: DatedCloseListing): TickerFinancials {
    return quote === financials.quote ? financials : { ...this.knownFinancials(financials, listing), quote };
  }

  /** The financials dated by what was read already: their quote and the contributions it is resolved from. */
  private knownFinancials(financials: TickerFinancials, listing: DatedCloseListing): TickerFinancials {
    const quote = this.previousCloseDates.known(financials.quote, listing);
    const contributions = financials.quoteContributions;
    const quoteContributions = contributions && Object.fromEntries(Object.entries(contributions)
      .map(([key, contribution]) => [key, this.previousCloseDates.known(contribution, listing)])) as QuoteContributionMap;
    const contributionsChanged = !!contributions && Object.keys(contributions).some((key) => quoteContributions![key] !== contributions[key]);
    if (quote === financials.quote && !contributionsChanged) return financials;
    return { ...financials, quote, ...(contributionsChanged ? { quoteContributions } : {}) };
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
      } catch (error) {
        logFailure("sources.provider-router.index", "Loading listing metadata failed")(error);
      }
    }
    return known ?? null;
  }

  setBackgroundRevalidation(enabled: boolean): void {
    this.revalidateInBackground = enabled;
  }

  get revalidatesInBackground(): boolean {
    return this.revalidateInBackground;
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

  searchBatch(queries: string[], options?: { limit?: number; signal?: AbortSignal }): Promise<Map<string, InstrumentSearchResult[]> | null> {
    return this.searchRoutes.searchBatch(queries, options);
  }

  /** The first source that answers a batch of symbol changes; null when none can or it fails. */
  async getTickerChangesBatch(symbols: string[], options?: { signal?: AbortSignal }): Promise<Map<string, TickerChanges | null> | null> {
    const provider = this.providersInPriorityOrder().find((candidate) => candidate.getTickerChangesBatch);
    if (!provider) return null;
    return await provider.getTickerChangesBatch!(symbols, options)
      .catch(logFailure("sources.provider-router.index", "Batched ticker changes failed", null));
  }

  /** The first source that keeps symbol changes answers; one that fails is passed over. */
  async getTickerChanges(symbol: string, options?: { signal?: AbortSignal }): Promise<TickerChanges | null> {
    for (const provider of this.providersInPriorityOrder()) {
      if (!provider.getTickerChanges) continue;
      try {
        return await provider.getTickerChanges(symbol, options);
      } catch {
        if (options?.signal?.aborted) return null;
      }
    }
    return null;
  }

  /** The first source that holds the company's listings; one that fails is passed over. */
  async getIssuerListings(symbol: string, exchange?: string, options?: { signal?: AbortSignal }): Promise<IssuerListings | null> {
    for (const provider of this.providersInPriorityOrder()) {
      if (!provider.getIssuerListings) continue;
      try {
        const listings = await provider.getIssuerListings(symbol, exchange, options);
        if (listings) return listings;
      } catch (error) {
        if (options?.signal?.aborted) return null;
        logFailure("sources.provider-router.index", "Issuer listings failed")(error);
      }
    }
    return null;
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
    return (await this.getCachedQuery("getOptionsChain", [ticker, exchange, expirationDate, context])
      .load({ force: context?.cacheMode === "refresh", background: this.revalidateInBackground && context?.cacheMode !== "current" })).value;
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
    // A read that lands dates the latest copy of a quote for the listing's subscribers.
    const listeners = mapped.valid.map((target) => {
      const key = datedCloseListingKey(listingOf(target));
      const listener = (quote: Quote) => onQuote(mapped.original(target), quote);
      const set = this.datedQuoteListeners.get(key) ?? new Set();
      set.add(listener);
      this.datedQuoteListeners.set(key, set);
      return { key, listener };
    });
    const unsubscribe = this.streamingRoutes.subscribeQuotes(mapped.valid, (target, quote) => {
      // A tick is dated by what was read already; one not yet read is read for the ticks after it.
      onQuote(mapped.original(target), this.previousCloseDates.observe(quote, listingOf(target, target.context)));
    });
    return () => {
      unsubscribe();
      for (const { key, listener } of listeners) {
        const set = this.datedQuoteListeners.get(key);
        set?.delete(listener);
        if (set?.size === 0) this.datedQuoteListeners.delete(key);
      }
    };
  }
}

function listingOf(target: { symbol: string; exchange?: string }, context?: MarketDataRequestContext): DatedCloseListing {
  return { symbol: target.symbol, exchange: target.exchange ?? "", ...(context ? { context } : {}) };
}

/** A request's context without the dating flag, which no source reads. */
function splitDating(requestContext?: MarketDataRequestContext): { context?: MarketDataRequestContext; datesChangeBasis: boolean } {
  if (!requestContext || !("datesChangeBasis" in requestContext)) return { context: requestContext, datesChangeBasis: false };
  const { datesChangeBasis, ...context } = requestContext;
  return { context: Object.keys(context).length ? context : undefined, datesChangeBasis: datesChangeBasis === true };
}

function withoutDating(options: QuoteBatchOptions): QuoteBatchOptions {
  if (!("datesChangeBasis" in options)) return options;
  const { datesChangeBasis: _dates, ...rest } = options;
  return rest;
}

/**
 * The context a listing's daily closes are read with: its broker contract, so
 * the chart's copy of them is shared, and nothing about the quote request.
 */
function listingHistoryContext(context?: MarketDataRequestContext): MarketDataRequestContext | undefined {
  if (!context) return undefined;
  const { brokerId, brokerInstanceId, instrument } = context;
  const history = { ...(brokerId ? { brokerId } : {}), ...(brokerInstanceId ? { brokerInstanceId } : {}), ...(instrument ? { instrument } : {}) };
  return Object.keys(history).length ? history : undefined;
}
