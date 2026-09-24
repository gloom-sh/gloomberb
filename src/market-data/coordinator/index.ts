import type { CachedAssetArgs, CachedAssetMethod, CachedAssetValue, DataProvider, SecFilingDocument, SecFilingItem } from "../../types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "../../types/financials";
import { fetchHistoryResult, type HistoryResultRequest } from "../../sources/history-result";
import type { ChartRequest, InstrumentRef, OptionsRequest, SecFilingsRequest } from "../request-types";
import { QueryStore } from "../query-store";
import type { QueryEntry } from "../result-types";
import type { CachedQueryHandle } from "../../data/cached-query";
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
import { measurePerf } from "../../utils/perf-marks";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { hasUsablePriceHistory } from "../../utils/price-history";
import { fxFreshUntil } from "../../utils/fx-market-hours";
import {
  createBaselineChartRequest,
  createChartLoadingEntry,
  freshChartFallback,
  normalizeFreshChartData,
} from "./chart";
import { MarketDataCoordinatorEvents } from "./events";
import type { DataFrameScheduler } from "../frame-scheduler";
import {
  FX_LIVE_RATE_MAX_AGE_MS,
  FX_LIVE_RATE_MAX_DEVIATION,
  FX_LIVE_RATE_MAX_OBSERVATION_AGE_MS,
  FX_LIVE_RATE_MIN_CHANGE,
  FX_LIVE_RATE_MIN_INTERVAL_MS,
  FX_LIVE_RATE_REFRESH_MS,
  FX_LIVE_RATE_STALE_MS,
  fxLegForCurrency,
  fxObservationAgeMs,
  fxRateFromLegQuote,
  type FxLeg,
} from "./fx-legs";
import {
  CHART_CACHE_TTL_MS,
  OPTIONS_CACHE_TTL_MS,
  EXPECTED_EMPTY,
  classifyError,
  createAttempt,
  errorEntry,
  hasFreshEntryData,
  hasFreshReadyEntry,
  readyEntry,
  readyChartEntry,
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
  type QuoteSubscriptionHandle,
  type QuoteSubscriptionRequest,
} from "./quotes";

/** How long a streamed tick may reuse the quote fields read from the cache. */
const STREAM_QUOTE_BASELINE_TTL_MS = 60_000;
/**
 * A repeat of an unchanged quote only moves its arrival time. Writing that
 * would re-render every reader per heartbeat, so it is recorded at most this
 * often: often enough that quote ages and the stream watchdog see a live feed.
 */
const STREAM_RECEIPT_REFRESH_MS = 5_000;
/** Keeps a long session of browsing from holding a baseline per visited symbol. */
const STREAM_QUOTE_BASELINE_LIMIT = 256;

// A store hands out a fresh idle entry for every key it has never seen, so
// two idle reads of the same key must count as the same entry.
function sameQueryEntry<T>(left: QueryEntry<T>, right: QueryEntry<T>): boolean {
  return left === right || (left.phase === "idle" && right.phase === "idle" && left.data === null && right.data === null);
}

export interface MarketDataCoordinatorOptions {
  /** The frame clock for stream applies and notifications; tests inject a manual one. */
  frames?: DataFrameScheduler;
}

export class MarketDataCoordinator {
  private readonly events: MarketDataCoordinatorEvents;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly optionsLoads = new Map<string, Promise<QueryEntry<OptionsChain>>>();
  private readonly chartRequests = new Map<string, ChartRequest>();
  private readonly quoteSubscriptionManager: QuoteSubscriptionManager;
  private destroyed = false;
  private readonly cachedQueries = new Map<string, { query: CachedQueryHandle<unknown>; dispose: () => void }>();
  private readonly streamQuoteBaselines = new Map<string, { baseline: TickerFinancials | null; readAt: number }>();

  private readonly quoteStore = new QueryStore<Quote>((key) => this.events.bump(key));
  private readonly snapshotStore = new QueryStore<TickerFinancials>((key) => this.events.bump(key));
  private readonly chartStore = new QueryStore<PricePoint[]>((key) => this.events.bump(key));
  private readonly optionsStore = new QueryStore<OptionsChain>((key) => this.events.bump(key));
  private readonly secFilingsStore = new QueryStore<SecFilingItem[]>((key) => this.events.bump(key));
  private readonly secDocumentsStore = new QueryStore<SecFilingDocument[]>((key) => this.events.bump(key));
  private readonly secContentStore = new QueryStore<string | null>((key) => this.events.bump(key));
  private readonly articleSummaryStore = new QueryStore<string | null>((key) => this.events.bump(key));
  private readonly liveFxRates = new Map<string, { rate: number; observedAt: number; receivedAt: number }>();
  /**
   * The last rate a request loaded per currency; a streamed rate must stay
   * near it to be believed, and one observed before it does not replace it.
   */
  private readonly loadedFxRates = new Map<string, { rate: number; asOf: number | null }>();
  /** The last pair quote each currency's leg received, as the stream sent it. */
  private readonly fxLegFrames = new Map<string, Quote>();
  private writingLiveFxRate = false;
  /** Currencies whose latest pair frame waits out FX_LIVE_RATE_MIN_INTERVAL_MS. */
  private readonly fxLegTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fxLegsByQuoteKey = new Map<string, FxLeg>();
  private readonly fxLegsByCurrency = new Map<string, FxLeg>();
  private readonly fxStore = new QueryStore<number>(
    (key) => this.events.bump(key),
    (key, entry) => this.projectLiveFxRate(key, entry),
  );
  private readonly financialCacheStores: FinancialCacheStores = {
    quoteStore: this.quoteStore,
    snapshotStore: this.snapshotStore,
    chartStore: this.chartStore,
  };

  constructor(private readonly dataProvider: DataProvider, options: MarketDataCoordinatorOptions = {}) {
    this.events = new MarketDataCoordinatorEvents(options.frames);
    this.quoteSubscriptionManager = new QuoteSubscriptionManager(
      dataProvider,
      (instrument, quote) => this.applyStreamQuote(instrument, quote),
      options.frames,
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

  /**
   * Building the merged view re-normalizes the whole price history, and every
   * consumer asks for it on every render. The result is kept per instrument
   * until one of the three store entries is replaced, so callers also get a
   * stable identity to memoize on.
   */
  private readonly financialsSnapshotCache = new Map<string, {
    snapshotEntry: QueryEntry<TickerFinancials>;
    quoteEntry: QueryEntry<Quote>;
    chartEntry: QueryEntry<PricePoint[]>;
    financials: TickerFinancials | null;
  }>();

  getTickerFinancialsSync(instrument: InstrumentRef): TickerFinancials | null {
    const key = buildSnapshotKey(instrument);
    const snapshotEntry = this.getSnapshotEntry(instrument);
    const quoteEntry = this.getQuoteEntry(instrument);
    const chartEntry = this.getChartEntry(createBaselineChartRequest(instrument));
    const cached = this.financialsSnapshotCache.get(key);
    if (
      cached
      && sameQueryEntry(cached.snapshotEntry, snapshotEntry)
      && sameQueryEntry(cached.quoteEntry, quoteEntry)
      && sameQueryEntry(cached.chartEntry, chartEntry)
    ) {
      return cached.financials;
    }
    const financials = buildTickerFinancialsSnapshot(snapshotEntry, quoteEntry, chartEntry);
    this.financialsSnapshotCache.set(key, { snapshotEntry, quoteEntry, chartEntry, financials });
    return financials;
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

  /**
   * Loads only what the caches lack for an instrument. Rows the user is about
   * to land on should have something to show; whether that something is
   * stale is for the pane that shows it to decide, so a warm-up never issues
   * a refresh of data that is already there.
   */
  warmTickerGaps(instrument: InstrumentRef | null | undefined): void {
    if (!instrument) return;
    if (resolveEntryData(this.getSnapshotEntry(instrument)) == null) {
      void this.loadSnapshot(instrument).catch(() => {});
    }
    const chartRequest = createBaselineChartRequest(instrument);
    if (resolveEntryData(this.getChartEntry(chartRequest)) == null) {
      void this.loadChart(chartRequest).catch(() => {});
    }
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
    const currentData = normalizeFreshChartData(resolveEntryData(current), request, current.history);
    if (!options.forceRefresh && currentData.length > 0 && hasFreshEntryData(current, CHART_CACHE_TTL_MS)) {
      if (currentData !== resolveEntryData(current)) {
        return this.chartStore.update(key, (entry) =>
          ({ ...entry, data: currentData, lastGoodData: currentData })
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
        const requested: HistoryResultRequest = request.granularity === "detail" && request.startDate && request.endDate && request.barSize
          ? { kind: "detail", start: request.startDate, end: request.endDate, interval: request.barSize }
          : request.granularity === "resolution" && request.resolution
            ? { kind: "resolution", range: request.bufferRange, resolution: request.resolution }
            : { kind: "range", range: request.bufferRange };
        const context = { ...toMarketDataContext(request.instrument),
          cacheMode: options.forceRefresh ? "refresh" as const : "default" as const };
        const load = (historyRequest: HistoryResultRequest) => fetchHistoryResult(this.dataProvider,
          request.instrument.symbol, request.instrument.exchange ?? "", historyRequest, context);
        const result = await load(requested) ?? await load({ kind: "range", range: request.bufferRange });
        if (!result) throw new Error("No chart history method is available");
        const { points, ...history } = result;
        const data = normalizeFreshChartData(points, request, history);
        const source = result.sourceKey ?? this.dataProvider.id;
        const status = hasUsablePriceHistory(data) ? "success" : "empty";
        const attempts = [createAttempt(source, startedAt, status, status === "empty" ? "NO_DATA" : undefined)];
        return this.chartStore.update(key, (current) => readyChartEntry(freshChartFallback(current, request), data.length > 0 ? data : null, source, attempts, history));
      } catch (error) {
        const classified = classifyError(error);
        const attempt = createAttempt(this.dataProvider.id, startedAt, EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error", classified.reasonCode, classified.message);
        return this.chartStore.update(key, (current) => errorEntry(freshChartFallback(current, request), attempt));
      }
    });
  }

  async loadOptions(
    request: OptionsRequest,
    options: { forceRefresh?: boolean } = {},
  ): Promise<QueryEntry<OptionsChain>> {
    const key = buildOptionsKey(request);
    const loadingKey = options.forceRefresh ? `${key}|refresh` : key;
    const existing = this.optionsLoads.get(loadingKey);
    if (existing) return existing;
    const load = async (): Promise<QueryEntry<OptionsChain>> => {
      if (request.expirationDate != null && !options.forceRefresh) {
        const defaultKey = buildOptionsKey({ instrument: request.instrument });
        // A concurrent OMON catalogue request already contains one actual slice.
        // Wait for its identity before requesting the same expiry again.
        await (this.optionsLoads.get(`${defaultKey}|refresh`) ?? this.optionsLoads.get(defaultKey));
        const catalogue = this.optionsStore.get(defaultKey);
        const contracts = catalogue.data ? [...catalogue.data.calls, ...catalogue.data.puts] : [];
        const now = Date.now();
        const fresh = (entry: QueryEntry<OptionsChain>) => hasFreshReadyEntry(entry, OPTIONS_CACHE_TTL_MS, now)
          && !entry.error && (entry.staleAt == null || entry.staleAt > now);
        if (fresh(catalogue) && contracts.length > 0
          && catalogue.data!.expirationDates.includes(request.expirationDate)
          && contracts.every((contract) => contract.expiration === request.expirationDate)) {
          const current = this.optionsStore.get(key);
          const currentNewer = current.fetchedAt != null && (current.fetchedAt > (catalogue.fetchedAt ?? 0)
            || (current.fetchedAt === catalogue.fetchedAt && (current.responseSequence ?? 0) >= (catalogue.responseSequence ?? 0)));
          if (fresh(current) && currentNewer) return current;
          if (!currentNewer && !current.error && current.phase !== "loading" && current.phase !== "refreshing") {
            this.optionsStore.set(key, catalogue);
            return catalogue;
          }
        }
      }
      return this.loadCachedQuery("getOptionsChain", [request.instrument.symbol, request.instrument.exchange, request.expirationDate, toMarketDataContext(request.instrument)], key, this.optionsStore, options.forceRefresh, (value) => value.expirationDates.length === 0) ?? loadOptionsEntry({
        dataProvider: this.dataProvider,
        forceRefresh: options.forceRefresh,
        request,
        store: this.optionsStore,
        runSingleFlight: (flightKey, task) => this.runSingleFlight(flightKey, task),
      });
    };
    const loading = load();
    this.optionsLoads.set(loadingKey, loading);
    try { return await loading; }
    finally { if (this.optionsLoads.get(loadingKey) === loading) this.optionsLoads.delete(loadingKey); }
  }

  async loadSecFilings(request: SecFilingsRequest, options: { forceRefresh?: boolean } = {}): Promise<QueryEntry<SecFilingItem[]>> {
    return this.loadCachedQuery("getSecFilings", [request.instrument.symbol, request.count ?? 50, request.instrument.exchange, toMarketDataContext(request.instrument)], buildSecFilingsKey(request), this.secFilingsStore, options.forceRefresh, (value) => value.length === 0) ?? loadSecFilingsEntry({
      forceRefresh: options.forceRefresh,
      dataProvider: this.dataProvider,
      request,
      store: this.secFilingsStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadSecFilingContent(filing: SecFilingItem, options: { forceRefresh?: boolean } = {}): Promise<QueryEntry<string | null>> {
    return this.loadCachedQuery("getSecFilingContent", [filing], buildSecContentKey(filing.accessionNumber), this.secContentStore, options.forceRefresh) ?? loadSecFilingContentEntry({
      forceRefresh: options.forceRefresh,
      dataProvider: this.dataProvider,
      filing,
      store: this.secContentStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadSecFilingDocuments(filing: SecFilingItem, options: { forceRefresh?: boolean } = {}): Promise<QueryEntry<SecFilingDocument[]>> {
    return this.loadCachedQuery("getSecFilingDocuments", [filing], buildSecDocumentsKey(filing.accessionNumber), this.secDocumentsStore, options.forceRefresh, (value) => value.length === 0) ?? loadSecFilingDocumentsEntry({
      forceRefresh: options.forceRefresh,
      dataProvider: this.dataProvider,
      filing,
      store: this.secDocumentsStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadArticleSummary(url: string): Promise<QueryEntry<string | null>> {
    return this.loadCachedQuery("getArticleSummary", [url], buildArticleSummaryKey(url), this.articleSummaryStore) ?? loadArticleSummaryEntry({
      dataProvider: this.dataProvider,
      url,
      store: this.articleSummaryStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  async loadFxRate(currency: string, options: { forceRefresh?: boolean } = {}): Promise<QueryEntry<number>> {
    return this.loadCachedQuery("getExchangeRate", [currency], buildFxKey(currency), this.fxStore, options.forceRefresh) ?? loadFxRateEntry({
      dataProvider: this.dataProvider,
      currency,
      forceRefresh: options.forceRefresh,
      store: this.fxStore,
      runSingleFlight: (key, task) => this.runSingleFlight(key, task),
    });
  }

  /** QueryStore is only a renderer projection here; the provider owns age and refreshes. */
  private loadCachedQuery<K extends CachedAssetMethod>(
    method: K,
    args: CachedAssetArgs<K>,
    key: string,
    store: QueryStore<CachedAssetValue<K>>,
    force = false,
    isEmpty: (value: CachedAssetValue<K>) => boolean = (value) => value == null,
  ): Promise<QueryEntry<CachedAssetValue<K>>> | undefined {
    if (this.destroyed) return Promise.resolve(store.get(key));
    const query = this.dataProvider.getCachedQuery?.(method, args);
    if (!query) return undefined;
    const update = () => {
      const { result, loading, error } = query.getSnapshot();
      const current = store.get(key);
      const empty = result != null && isEmpty(result.value);
      // An empty options catalogue is itself a successful observation. Retain
      // it through errors so old expirations cannot return via lastGoodData.
      const value = result && (!empty || method === "getOptionsChain") ? result.value : null;
      const classified = error ? classifyError(error) : null;
      store.set(key, {
        phase: loading ? (result ? "refreshing" : "loading") : result ? "ready" : "error",
        data: value,
        // FX query ownership includes the maximum source age. A null result
        // means there is no valid conversion fallback left to project.
        lastGoodData: value ?? (method === "getExchangeRate" ? null : current.lastGoodData),
        source: result?.source ?? null,
        fetchedAt: result?.fetchedAt ?? null,
        responseSequence: result?.responseSequence,
        asOf: result?.asOf,
        staleAt: result?.staleAt ?? null,
        error: classified ?? (!loading && empty ? { reasonCode: "NO_DATA", message: "No data available" } : null),
        attempts: result ? [createAttempt(result.source, result.fetchedAt, error ? "fatal_error" : empty ? "empty" : "success", classified?.reasonCode, classified?.message)] : [],
      });
    };
    const existing = this.cachedQueries.get(key);
    if (existing?.query !== query) {
      existing?.dispose();
      this.cachedQueries.set(key, { query, dispose: query.subscribe(update) });
      update();
    }
    // A CLI report exits before a background refresh lands, so it would
    // print a stale entry (options chains stay stored for two days).
    return query.load({ force, background: this.dataProvider.revalidatesInBackground ?? true }).then(
      () => { if (this.cachedQueries.get(key)?.query === query) update(); return store.get(key); },
      () => store.get(key),
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.quoteSubscriptionManager.dispose();
    this.events.dispose();
    for (const { dispose } of this.cachedQueries.values()) dispose();
    this.cachedQueries.clear();
    this.streamQuoteBaselines.clear();
    for (const timer of this.fxLegTimers.values()) clearTimeout(timer);
    this.fxLegTimers.clear();
  }

  subscribeQuotes(targets: QuoteSubscriptionRequest[]): QuoteSubscriptionHandle {
    return this.quoteSubscriptionManager.subscribe(targets);
  }

  /**
   * Streams the USD pair behind each currency so converted values move with
   * the market. The pairs ride the normal quote subscription (one per pair,
   * shared by every caller) at background priority, and their mids replace
   * the loaded rate while they are current; the loaded rate stays the fallback.
   */
  subscribeFxRates(currencies: readonly string[]): QuoteSubscriptionHandle {
    const legs = new Map<string, FxLeg>();
    for (const currency of currencies) {
      const leg = fxLegForCurrency(currency);
      if (!leg) continue;
      const key = buildQuoteKey(leg.instrument);
      legs.set(key, leg);
      this.fxLegsByQuoteKey.set(key, leg);
      this.fxLegsByCurrency.set(leg.currency, leg);
    }
    return this.quoteSubscriptionManager.subscribe([...legs.values()].map((leg) => ({
      instrument: leg.instrument,
      priority: { visible: false, selected: false, weight: 20 },
    })));
  }

  private applyLiveFxLeg(leg: FxLeg, quote: Quote | undefined): void {
    if (!quote || quote.stale === true) return;
    const now = Date.now();
    // Only a current observation is a live rate; a delayed or quiet pair
    // leaves the loaded rate in charge.
    if (!Number.isFinite(quote.lastUpdated) || quote.lastUpdated <= 0
      || fxObservationAgeMs(quote.lastUpdated, now) > FX_LIVE_RATE_MAX_OBSERVATION_AGE_MS) return;
    const observedAt = Math.min(quote.lastUpdated, now);
    const rate = fxRateFromLegQuote(leg, quote);
    if (rate == null) return;
    // Without a loaded rate there is nothing to catch a wrong pair or a bad print.
    const reference = this.loadedFxRates.get(leg.currency);
    if (reference == null || Math.abs(rate / reference.rate - 1) > FX_LIVE_RATE_MAX_DEVIATION) return;
    if (reference.asOf != null && reference.asOf > observedAt) return;
    const previous = this.liveFxRates.get(leg.currency);
    if (previous && Math.abs(rate / previous.rate - 1) < FX_LIVE_RATE_MIN_CHANGE && now - previous.receivedAt < FX_LIVE_RATE_REFRESH_MS) return;
    // A clock set back counts as time up rather than freezing the rate.
    const wait = previous && now >= previous.receivedAt ? previous.receivedAt + FX_LIVE_RATE_MIN_INTERVAL_MS - now : 0;
    if (wait > 0) {
      this.scheduleLiveFxLeg(leg, wait);
      return;
    }
    this.liveFxRates.set(leg.currency, { rate, observedAt, receivedAt: now });
    const key = buildFxKey(leg.currency);
    this.writingLiveFxRate = true;
    try {
      this.fxStore.set(key, this.fxStore.get(key));
    } finally {
      this.writingLiveFxRate = false;
    }
  }

  /** Applies the leg's latest frame once the interval since the last write is up. */
  private scheduleLiveFxLeg(leg: FxLeg, delayMs: number): void {
    if (this.destroyed || this.fxLegTimers.has(leg.currency)) return;
    const timer = setTimeout(() => {
      this.fxLegTimers.delete(leg.currency);
      if (!this.destroyed) this.applyLiveFxLeg(leg, this.fxLegFrames.get(leg.currency));
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.fxLegTimers.set(leg.currency, timer);
  }

  private projectLiveFxRate(key: string, entry: QueryEntry<number>): QueryEntry<number> {
    const currency = key.slice(key.indexOf(":") + 1);
    const live = this.liveFxRates.get(currency);
    const loaded = entry.data ?? entry.lastGoodData;
    // A loading or error entry built from the current one still carries the
    // streamed value; only a rate a request produced is a reference.
    if (!this.writingLiveFxRate && loaded != null && Number.isFinite(loaded) && loaded > 0 && loaded !== live?.rate) {
      const firstReference = !this.loadedFxRates.has(currency);
      const asOf = typeof entry.asOf === "number" && Number.isFinite(entry.asOf) ? entry.asOf : null;
      this.loadedFxRates.set(currency, { rate: loaded, asOf });
      // A pair that streamed before any rate loaded can be checked now.
      const leg = firstReference && !live ? this.fxLegsByCurrency.get(currency) : undefined;
      if (leg) queueMicrotask(() => this.applyLiveFxLeg(leg, this.fxLegFrames.get(leg.currency)));
    }
    if (!live || fxObservationAgeMs(live.observedAt, Date.now()) > FX_LIVE_RATE_MAX_AGE_MS) return entry;
    // A request that observed the market after the last tick is the better rate.
    const loadedAsOf = this.loadedFxRates.get(currency)?.asOf;
    if (loadedAsOf != null && loadedAsOf > live.observedAt) return entry;
    if (entry.data === live.rate && entry.asOf === live.observedAt) return entry;
    return {
      ...entry,
      phase: "ready",
      data: live.rate,
      lastGoodData: live.rate,
      error: null,
      asOf: live.observedAt,
      fetchedAt: Math.max(entry.fetchedAt ?? 0, live.receivedAt),
      staleAt: fxFreshUntil(live.observedAt, FX_LIVE_RATE_STALE_MS),
    };
  }

  private applyStreamQuote(instrument: InstrumentRef, quote: Quote): void {
    const key = buildQuoteKey(instrument);
    const current = this.quoteStore.get(key);
    const resolvedQuote = quote.stale === true ? quote : this.resolveIncomingQuote(instrument, quote);
    const startedAt = Date.now();
    const receivedAt = resolvedQuote.stale === true ? resolvedQuote.receivedAt : startedAt;
    const storedQuote = receivedAt == null ? resolvedQuote : { ...resolvedQuote, receivedAt };
    const currentQuote = current.data ?? current.lastGoodData;
    if (areStreamQuotesEquivalent(currentQuote, storedQuote)) {
      const previousReceipt = currentQuote?.receivedAt;
      if (receivedAt == null || (previousReceipt != null && receivedAt - previousReceipt < STREAM_RECEIPT_REFRESH_MS)) return;
    }
    const attempts = [createAttempt(resolvedQuote.providerId ?? this.dataProvider.id, startedAt, "success")];
    const entry = readyQuoteEntry(current, storedQuote, resolvedQuote.providerId ?? this.dataProvider.id, attempts);
    this.quoteStore.set(key, entry);
    const fxLeg = this.fxLegsByQuoteKey.get(key);
    if (fxLeg && entry.data) {
      this.fxLegFrames.set(fxLeg.currency, quote);
      this.applyLiveFxLeg(fxLeg, quote);
    }
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
        return snapshot.quote;
      }
    }
    const cachedFinancials = snapshot ?? this.streamQuoteBaseline(instrument);
    return resolveTickerFinancialsQuoteState(cachedFinancials, quote)?.quote ?? quote;
  }

  /**
   * What a streamed tick is merged onto before a real snapshot exists. Reading
   * it from the resource cache costs a query, a parse and a sanitize of the
   * whole financial record, and a batch of ticks used to pay that per symbol,
   * per tick: a burst after subscribing to a pane froze the app for as long as
   * it took to walk every record. Only the quote fields survive the read, and
   * one read per instrument per minute is enough, because a snapshot takes
   * over as soon as one loads and the record on disk is not moving meanwhile.
   */
  private streamQuoteBaseline(instrument: InstrumentRef): TickerFinancials | null {
    const key = buildSnapshotKey(instrument);
    const now = Date.now();
    const memo = this.streamQuoteBaselines.get(key);
    if (memo && now - memo.readAt < STREAM_QUOTE_BASELINE_TTL_MS) return memo.baseline;

    const cached = this.readCachedFinancialsForInstrument(instrument);
    const baseline: TickerFinancials | null = cached && {
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: cached.quote,
      quoteMetadata: cached.quoteMetadata,
      quoteContributions: cached.quoteContributions,
    };
    if (this.streamQuoteBaselines.size >= STREAM_QUOTE_BASELINE_LIMIT) {
      for (const [staleKey, entry] of this.streamQuoteBaselines) {
        if (now - entry.readAt >= STREAM_QUOTE_BASELINE_TTL_MS) this.streamQuoteBaselines.delete(staleKey);
      }
      if (this.streamQuoteBaselines.size >= STREAM_QUOTE_BASELINE_LIMIT) this.streamQuoteBaselines.clear();
    }
    this.streamQuoteBaselines.set(key, { baseline, readAt: now });
    return baseline;
  }

  private readCachedFinancialsForInstrument(instrument: InstrumentRef): TickerFinancials | null {
    if (!this.dataProvider.getCachedFinancialsForTargets) return null;
    return measurePerf("market-data.quote-baseline-read", () => {
      const result = this.dataProvider.getCachedFinancialsForTargets!([{
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
    }, { symbol: instrument.symbol });
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
