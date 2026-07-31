import type { DataProvider, SecFilingDocument, SecFilingItem } from "../../types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "../../types/financials";
import type { ChartRequest, InstrumentRef, OptionsRequest, SecFilingsRequest } from "../request-types";
import { QueryStore } from "../query-store";
import type { QueryEntry } from "../result-types";
import {
  buildArticleSummaryKey,
  buildChartKey,
  buildFxKey,
  buildTickerFinancialsSnapshot,
  buildOptionsKey,
  buildQuoteKey,
  buildSecContentKey,
  buildSecDocumentsKey,
  buildSecFilingsKey,
  buildSnapshotKey,
  resolveEntryData,
  toMarketDataContext,
} from "../selectors";
import { resolveTickerFinancialsQuoteState } from "../quotes/resolution";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { normalizePriceHistory } from "../../utils/price-history";
import {
  createBaselineChartRequest,
  createChartLoadingEntry,
  normalizeFreshChartData,
} from "./chart";
import { MarketDataCoordinatorEvents } from "./events";
import {
  CHART_CACHE_TTL_MS,
  EXPECTED_EMPTY,
  classifyError,
  createAttempt,
  errorEntry,
  hasFreshEntryData,
  readyEntry,
  readyQuoteEntry,
} from "./entries";
import {
  loadArticleSummaryEntry,
  loadFxRateEntry,
  loadOptionsEntry,
  loadSecFilingContentEntry,
  loadSecFilingDocumentsEntry,
  loadSecFilingsEntry,
} from "./auxiliary";
import {
  loadFinancialsSnapshotBatch,
  loadFinancialsSnapshotEntry,
  primeFinancialsCache,
  type FinancialCacheStores,
} from "./financials";
import {
  areStreamQuotesEquivalent,
  loadQuoteBatchEntries,
  loadQuoteEntry,
  QuoteSubscriptionManager,
  type QuoteSubscriptionPriority,
} from "./quotes";

export class MarketDataCoordinator {
  private readonly events = new MarketDataCoordinatorEvents();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly chartRequests = new Map<string, ChartRequest>();
  private readonly quoteSubscriptionManager: QuoteSubscriptionManager;

  private readonly quoteStore = new QueryStore<Quote>((key) => this.events.bump(key));
  private readonly snapshotStore = new QueryStore<TickerFinancials>((key) => this.events.bump(key));
  private readonly profileStore = new QueryStore<TickerFinancials["profile"]>((key) => this.events.bump(key));
  private readonly fundamentalsStore = new QueryStore<TickerFinancials["fundamentals"]>((key) => this.events.bump(key));
  private readonly statementsStore = new QueryStore<Pick<TickerFinancials, "annualStatements" | "quarterlyStatements">>((key) => this.events.bump(key));
  private readonly chartStore = new QueryStore<PricePoint[]>((key) => this.events.bump(key));
  private readonly optionsStore = new QueryStore<OptionsChain>((key) => this.events.bump(key));
  private readonly secFilingsStore = new QueryStore<SecFilingItem[]>((key) => this.events.bump(key));
  private readonly secDocumentsStore = new QueryStore<SecFilingDocument[]>((key) => this.events.bump(key));
  private readonly secContentStore = new QueryStore<string | null>((key) => this.events.bump(key));
  private readonly articleSummaryStore = new QueryStore<string | null>((key) => this.events.bump(key));
  private readonly fxStore = new QueryStore<number>((key) => this.events.bump(key));
  private readonly financialCacheStores: FinancialCacheStores = {
    quoteStore: this.quoteStore,
    snapshotStore: this.snapshotStore,
    profileStore: this.profileStore,
    fundamentalsStore: this.fundamentalsStore,
    statementsStore: this.statementsStore,
    chartStore: this.chartStore,
  };

  constructor(private readonly dataProvider: DataProvider) {
    this.quoteSubscriptionManager = new QuoteSubscriptionManager(
      dataProvider,
      (instrument, quote) => this.applyStreamQuote(instrument, quote),
    );
  }

  subscribe(listener: () => void): () => void {
    return this.events.subscribe(listener);
  }

  subscribeKeys(keys: readonly string[], listener: () => void): () => void {
    return this.events.subscribeKeys(keys, listener);
  }

  getVersion(): number {
    return this.events.getVersion();
  }

  getKeysVersion(keys: readonly string[]): number {
    return this.events.getKeysVersion(keys);
  }

  getQuoteEntry(instrument: InstrumentRef): QueryEntry<Quote> {
    return this.quoteStore.get(buildQuoteKey(instrument));
  }

  getSnapshotEntry(instrument: InstrumentRef): QueryEntry<TickerFinancials> {
    return this.snapshotStore.get(buildSnapshotKey(instrument));
  }

  getChartEntry(request: ChartRequest): QueryEntry<PricePoint[]> {
    return this.chartStore.get(buildChartKey(request));
  }

  getOptionsEntry(request: OptionsRequest): QueryEntry<OptionsChain> {
    return this.optionsStore.get(buildOptionsKey(request));
  }

  getSecFilingsEntry(request: SecFilingsRequest): QueryEntry<SecFilingItem[]> {
    return this.secFilingsStore.get(buildSecFilingsKey(request));
  }

  getSecContentEntry(accessionNumber: string): QueryEntry<string | null> {
    return this.secContentStore.get(buildSecContentKey(accessionNumber));
  }

  getSecDocumentsEntry(accessionNumber: string): QueryEntry<SecFilingDocument[]> {
    return this.secDocumentsStore.get(buildSecDocumentsKey(accessionNumber));
  }

  getArticleSummaryEntry(url: string): QueryEntry<string | null> {
    return this.articleSummaryStore.get(buildArticleSummaryKey(url));
  }

  getFxEntry(currency: string): QueryEntry<number> {
    return this.fxStore.get(buildFxKey(currency));
  }

  getTickerFinancialsSync(instrument: InstrumentRef): TickerFinancials | null {
    return buildTickerFinancialsSnapshot(
      this.getSnapshotEntry(instrument),
      this.getQuoteEntry(instrument),
      this.getChartEntry(createBaselineChartRequest(instrument)),
    );
  }

  primeCachedFinancials(entries: Array<{ instrument: InstrumentRef; financials: TickerFinancials }>): void {
    for (const { instrument, financials } of entries) {
      primeFinancialsCache(this.financialCacheStores, instrument, financials, this.dataProvider.id);
    }
  }

  prefetchTicker(instrument: InstrumentRef | null | undefined): void {
    if (!instrument) return;
    void this.loadSnapshot(instrument).catch(() => {});
    void this.loadChart(createBaselineChartRequest(instrument)).catch(() => {});
  }

  private runSingleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = task().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async loadSnapshot(
    instrument: InstrumentRef,
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<TickerFinancials>> {
    return loadFinancialsSnapshotEntry({
      dataProvider: this.dataProvider,
      instrument,
      options,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
      stores: this.financialCacheStores,
    });
  }

  async loadSnapshotsBatch(
    instruments: InstrumentRef[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<TickerFinancials>[]> {
    return loadFinancialsSnapshotBatch({
      dataProvider: this.dataProvider,
      instruments,
      options,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
      stores: this.financialCacheStores,
    });
  }

  async loadQuote(
    instrument: InstrumentRef,
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<Quote>> {
    return loadQuoteEntry({
      dataProvider: this.dataProvider,
      instrument,
      options,
      quoteStore: this.quoteStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
      resolveQuote: (targetInstrument, quote) => this.resolveIncomingQuote(targetInstrument, quote),
    });
  }

  async loadQuotesBatch(
    instruments: InstrumentRef[],
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<Quote>[]> {
    return loadQuoteBatchEntries({
      dataProvider: this.dataProvider,
      instruments,
      options,
      quoteStore: this.quoteStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
      resolveQuote: (targetInstrument, quote) => this.resolveIncomingQuote(targetInstrument, quote),
    });
  }

  async loadChart(
    request: ChartRequest,
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<PricePoint[]>> {
    const key = buildChartKey(request);
    this.chartRequests.set(key, request);
    const current = this.chartStore.get(key);
    const currentData = normalizeFreshChartData(resolveEntryData(current), request);
    if (!options.forceRefresh && currentData.length > 0 && hasFreshEntryData(current, CHART_CACHE_TTL_MS)) {
      if (currentData !== resolveEntryData(current)) {
        return this.chartStore.update(key, (entry) =>
          readyEntry(entry, currentData, entry.source ?? this.dataProvider.id, entry.attempts, { keepLastGoodOnEmpty: true })
        );
      }
      return current;
    }
    const flightKey = options.forceRefresh ? `${key}|refresh` : key;
    return this.runSingleFlight(flightKey, async () => {
      this.chartStore.update(key, (current) => createChartLoadingEntry({
        key,
        request,
        current,
        chartRequests: this.chartRequests,
        getEntry: (entryKey) => this.chartStore.get(entryKey),
        resolveEntryData,
      }));
      const startedAt = Date.now();
      try {
        const data = normalizePriceHistory(
          request.granularity === "detail" && request.startDate && request.endDate && request.barSize && this.dataProvider.getDetailedPriceHistory
            ? await this.dataProvider.getDetailedPriceHistory(
              request.instrument.symbol,
              request.instrument.exchange ?? "",
              request.startDate,
              request.endDate,
              request.barSize,
              {
                ...toMarketDataContext(request.instrument),
                cacheMode: options.forceRefresh ? "refresh" : "default",
              },
            )
            : request.granularity === "resolution" && request.resolution && this.dataProvider.getPriceHistoryForResolution
              ? await this.dataProvider.getPriceHistoryForResolution(
                request.instrument.symbol,
                request.instrument.exchange ?? "",
                request.bufferRange,
                request.resolution,
                {
                  ...toMarketDataContext(request.instrument),
                  cacheMode: options.forceRefresh ? "refresh" : "default",
                },
              )
            : await this.dataProvider.getPriceHistory(
              request.instrument.symbol,
              request.instrument.exchange ?? "",
              request.bufferRange,
              {
                ...toMarketDataContext(request.instrument),
                cacheMode: options.forceRefresh ? "refresh" : "default",
              },
            ),
        );
        const status = data.length > 0 ? "success" : "empty";
        const attempts = [createAttempt(this.dataProvider.id, startedAt, status, data.length === 0 ? "NO_DATA" : undefined)];
        return this.chartStore.update(key, (current) => readyEntry(current, data.length > 0 ? data : null, this.dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
      } catch (error) {
        const classified = classifyError(error);
        const attempt = createAttempt(this.dataProvider.id, startedAt, EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error", classified.reasonCode, classified.message);
        return this.chartStore.update(key, (current) => errorEntry(current, attempt));
      }
    });
  }

  async loadOptions(
    request: OptionsRequest,
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<OptionsChain>> {
    return loadOptionsEntry({
      dataProvider: this.dataProvider,
      forceRefresh: options.forceRefresh,
      request,
      store: this.optionsStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadSecFilings(request: SecFilingsRequest): Promise<QueryEntry<SecFilingItem[]>> {
    return loadSecFilingsEntry({
      dataProvider: this.dataProvider,
      request,
      store: this.secFilingsStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadSecFilingContent(filing: SecFilingItem): Promise<QueryEntry<string | null>> {
    return loadSecFilingContentEntry({
      dataProvider: this.dataProvider,
      filing,
      store: this.secContentStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadSecFilingDocuments(filing: SecFilingItem): Promise<QueryEntry<SecFilingDocument[]>> {
    return loadSecFilingDocumentsEntry({
      dataProvider: this.dataProvider,
      filing,
      store: this.secDocumentsStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadArticleSummary(url: string): Promise<QueryEntry<string | null>> {
    return loadArticleSummaryEntry({
      dataProvider: this.dataProvider,
      url,
      store: this.articleSummaryStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadFxRate(currency: string): Promise<QueryEntry<number>> {
    return loadFxRateEntry({
      dataProvider: this.dataProvider,
      currency,
      store: this.fxStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  subscribeQuotes(targets: Array<{ instrument: InstrumentRef; priority?: QuoteSubscriptionPriority }>): () => void {
    return this.quoteSubscriptionManager.subscribe(targets);
  }

  private applyStreamQuote(instrument: InstrumentRef, quote: Quote): void {
    const key = buildQuoteKey(instrument);
    const current = this.quoteStore.get(key);
    const resolvedQuote = quote.stale === true ? quote : this.resolveIncomingQuote(instrument, quote);
    const startedAt = Date.now();
    const receivedAt = resolvedQuote.stale === true ? resolvedQuote.receivedAt : startedAt;
    const storedQuote = receivedAt == null ? resolvedQuote : { ...resolvedQuote, receivedAt };
    if (areStreamQuotesEquivalent(current.data ?? current.lastGoodData, storedQuote)) return;
    const attempts = [createAttempt(resolvedQuote.providerId ?? this.dataProvider.id, startedAt, "success")];
    this.quoteStore.set(key, readyQuoteEntry(current, storedQuote, resolvedQuote.providerId ?? this.dataProvider.id, attempts));
  }

  private resolveIncomingQuote(instrument: InstrumentRef, quote: Quote): Quote {
    const snapshot = resolveEntryData(this.snapshotStore.get(buildSnapshotKey(instrument)));
    if (snapshot?.quote) {
      if (hasLikelyQuoteUnitMismatch(snapshot.quote, quote)) return quote;
      if (
        typeof snapshot.quote.lastUpdated === "number"
        && typeof quote.lastUpdated === "number"
        && quote.lastUpdated < snapshot.quote.lastUpdated
      ) {
        return quote;
      }
    }
    const cachedFinancials = snapshot ?? this.readCachedFinancialsForInstrument(instrument);
    return resolveTickerFinancialsQuoteState(cachedFinancials, quote)?.quote ?? quote;
  }

  private readCachedFinancialsForInstrument(instrument: InstrumentRef): TickerFinancials | null {
    if (!this.dataProvider.getCachedFinancialsForTargets) return null;
    const result = this.dataProvider.getCachedFinancialsForTargets([{
      symbol: instrument.symbol,
      exchange: instrument.exchange,
      brokerId: instrument.brokerId,
      brokerInstanceId: instrument.brokerInstanceId,
      instrument: instrument.instrument ?? null,
    }], {
      allowExpired: true,
      includeStaleQuotes: true,
    });
    if (result instanceof Promise) return null;
    return result.get(instrument.symbol.trim().toUpperCase()) ?? null;
  }
}

let sharedCoordinator: MarketDataCoordinator | null = null;

export function setSharedMarketDataCoordinator(coordinator: MarketDataCoordinator | null): void {
  sharedCoordinator = coordinator;
}

export function getSharedMarketDataCoordinator(): MarketDataCoordinator | null {
  return sharedCoordinator;
}

export function resolveTickerFinancialsForInstrument(instrument: InstrumentRef | null | undefined): TickerFinancials | null {
  if (!instrument || !sharedCoordinator) return null;
  return sharedCoordinator.getTickerFinancialsSync(instrument);
}

export function resolveEntryValue<T>(entry: QueryEntry<T>): T | null {
  return resolveEntryData(entry);
}
