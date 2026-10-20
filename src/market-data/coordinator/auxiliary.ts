import { nextResponseSequence } from "../../data/response-sequence";
import { exchangeRateMetadata, isUsableCachedExchangeRate } from "../../utils/exchange-rate-snapshot";
import { fixedUsdRate } from "../../utils/currency-units";
import type { DataProvider, SecFilingDocument, SecFilingItem } from "../../types/data-provider";
import type { OptionsChain } from "../../types/financials";
import type { OptionsRequest, SecFilingsRequest } from "../request-types";
import type { QueryEntry } from "../result-types";
import { QueryStore } from "../query-store";
import {
  ARTICLE_SUMMARY_CACHE_TTL_MS,
  EXPECTED_EMPTY,
  FX_CACHE_TTL_MS,
  OPTIONS_CACHE_TTL_MS,
  SEC_CONTENT_CACHE_TTL_MS,
  SEC_FILINGS_CACHE_TTL_MS,
  classifyError,
  createAttempt,
  errorEntry,
  hasFreshEntryData,
  hasFreshReadyEntry,
  loadingEntry,
  readyEntry,
} from "./entries";
import {
  buildArticleSummaryKey,
  buildFxKey,
  buildOptionsKey,
  buildSecContentKey,
  buildSecDocumentsKey,
  buildSecFilingsKey,
  toMarketDataContext,
} from "../selectors";

type RunSingleFlight = <T>(key: string, task: () => Promise<T>) => Promise<T>;

interface AuxiliaryLoaderOptions<T> {
  /** SEC resources join an active request; a completed request can be forced again. */
  coalesceRefresh?: boolean;
  dataProvider: DataProvider;
  forceRefresh?: boolean;
  key: string;
  store: QueryStore<T>;
  ttlMs: number;
  runSingleFlight: RunSingleFlight;
  load: (startedAt: number) => Promise<QueryEntry<T>>;
}

export function loadOptionsEntry(options: {
  dataProvider: DataProvider;
  forceRefresh?: boolean;
  request: OptionsRequest;
  store: QueryStore<OptionsChain>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<OptionsChain>> {
  const { dataProvider, forceRefresh = false, request, store, runSingleFlight } = options;
  const key = buildOptionsKey(request);
  return loadAuxiliaryEntry({
    dataProvider,
    forceRefresh,
    key,
    store,
    ttlMs: OPTIONS_CACHE_TTL_MS,
    runSingleFlight,
    load: async (startedAt) => {
      if (!dataProvider.getOptionsChain) {
        const attempt = createAttempt(dataProvider.id, startedAt, "unsupported", "UNSUPPORTED_RANGE", "Options are not available");
        return store.update(key, (current) => errorEntry(current, attempt));
      }
      // This path has no handle on the provider's cache, so a refresh it asks for must reach the source, and a
      // stored chain past its stale time (kept for two days) is refetched rather than shown as current.
      const data = await dataProvider.getOptionsChain(
        request.instrument.symbol,
        request.instrument.exchange ?? "",
        request.expirationDate,
        { ...toMarketDataContext(request.instrument), cacheMode: forceRefresh ? "refresh" : "current" },
      );
      const attempts = [createAttempt(dataProvider.id, startedAt, data.expirationDates.length > 0 ? "success" : "empty", data.expirationDates.length === 0 ? "NO_DATA" : undefined)];
      return store.update(key, (current) => ({
        ...readyEntry(current, data, dataProvider.id, attempts),
        responseSequence: nextResponseSequence(),
        error: data.expirationDates.length === 0 ? { reasonCode: "NO_DATA", message: "No data available" } : null,
      }));
    },
  });
}

export function loadSecFilingsEntry(options: {
  dataProvider: DataProvider;
  forceRefresh?: boolean;
  request: SecFilingsRequest;
  store: QueryStore<SecFilingItem[]>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<SecFilingItem[]>> {
  const { dataProvider, forceRefresh = false, request, store, runSingleFlight } = options;
  const key = buildSecFilingsKey(request);
  return loadAuxiliaryEntry({
    dataProvider,
    forceRefresh,
    coalesceRefresh: true,
    key,
    store,
    ttlMs: SEC_FILINGS_CACHE_TTL_MS,
    runSingleFlight,
    load: async (startedAt) => {
      if (!dataProvider.getSecFilings) {
        const attempt = createAttempt(dataProvider.id, startedAt, "unsupported", "UNSUPPORTED_RANGE", "SEC filings are not available");
        return store.update(key, (current) => errorEntry(current, attempt));
      }
      const data = await dataProvider.getSecFilings(
        request.instrument.symbol,
        request.count ?? 50,
        request.instrument.exchange ?? "",
        { ...toMarketDataContext(request.instrument), ...(forceRefresh ? { cacheMode: "refresh" as const } : {}) },
      );
      const attempts = [createAttempt(dataProvider.id, startedAt, data.length > 0 ? "success" : "empty", data.length === 0 ? "NO_DATA" : undefined)];
      return store.update(key, (current) => readyEntry(current, data.length > 0 ? data : null, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadSecFilingContentEntry(options: {
  dataProvider: DataProvider;
  forceRefresh?: boolean;
  filing: SecFilingItem;
  store: QueryStore<string | null>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<string | null>> {
  const { dataProvider, forceRefresh = false, filing, store, runSingleFlight } = options;
  const key = buildSecContentKey(filing.accessionNumber);
  return loadAuxiliaryEntry({
    dataProvider,
    forceRefresh,
    coalesceRefresh: true,
    key,
    store,
    ttlMs: SEC_CONTENT_CACHE_TTL_MS,
    runSingleFlight,
    load: async (startedAt) => {
      if (!dataProvider.getSecFilingContent) {
        const attempt = createAttempt(dataProvider.id, startedAt, "unsupported", "UNSUPPORTED_RANGE", "SEC filing content is not available");
        return store.update(key, (current) => errorEntry(current, attempt));
      }
      const data = await dataProvider.getSecFilingContent(filing);
      const status = data ? "success" : "empty";
      const attempts = [createAttempt(dataProvider.id, startedAt, status, data ? undefined : "NO_DATA")];
      return store.update(key, (current) => readyEntry(current, data, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadSecFilingDocumentsEntry(options: {
  dataProvider: DataProvider;
  forceRefresh?: boolean;
  filing: SecFilingItem;
  store: QueryStore<SecFilingDocument[]>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<SecFilingDocument[]>> {
  const { dataProvider, forceRefresh = false, filing, store, runSingleFlight } = options;
  const key = buildSecDocumentsKey(filing.accessionNumber);
  return loadAuxiliaryEntry({
    dataProvider,
    forceRefresh,
    coalesceRefresh: true,
    key,
    store,
    ttlMs: SEC_CONTENT_CACHE_TTL_MS,
    runSingleFlight,
    load: async (startedAt) => {
      if (!dataProvider.getSecFilingDocuments) {
        const attempt = createAttempt(dataProvider.id, startedAt, "unsupported", "UNSUPPORTED_RANGE", "SEC filing documents are not available");
        return store.update(key, (current) => errorEntry(current, attempt));
      }
      const data = await dataProvider.getSecFilingDocuments(filing);
      const status = data.length > 0 ? "success" : "empty";
      const attempts = [createAttempt(dataProvider.id, startedAt, status, data.length > 0 ? undefined : "NO_DATA")];
      return store.update(key, (current) => readyEntry(current, data.length > 0 ? data : null, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadArticleSummaryEntry(options: {
  dataProvider: DataProvider;
  url: string;
  store: QueryStore<string | null>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<string | null>> {
  const { dataProvider, url, store, runSingleFlight } = options;
  const key = buildArticleSummaryKey(url);
  return loadAuxiliaryEntry({
    dataProvider,
    key,
    store,
    ttlMs: ARTICLE_SUMMARY_CACHE_TTL_MS,
    runSingleFlight,
    load: async (startedAt) => {
      const data = await dataProvider.getArticleSummary(url);
      const status = data ? "success" : "empty";
      const attempts = [createAttempt(dataProvider.id, startedAt, status, data ? undefined : "NO_DATA")];
      return store.update(key, (current) => readyEntry(current, data, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadFxRateEntry(options: {
  dataProvider: DataProvider;
  currency: string;
  forceRefresh?: boolean;
  store: QueryStore<number>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<number>> {
  const { dataProvider, store, runSingleFlight } = options;
  const normalizedCurrency = options.currency.trim().toUpperCase();
  const key = buildFxKey(normalizedCurrency);
  const current = store.get(key);
  if (!options.forceRefresh && hasFreshEntryData(current, FX_CACHE_TTL_MS) && !current.error
    && (current.staleAt == null || current.staleAt > Date.now())) {
    return Promise.resolve(current);
  }
  // The dollar, and US cents at a hundredth of it, are fixed: nothing to ask a source for.
  const fixedRate = fixedUsdRate(normalizedCurrency);
  if (fixedRate !== undefined) {
    const startedAt = Date.now();
    const attempts = [createAttempt("static", startedAt, "success")];
    return Promise.resolve(store.update(key, (current) => readyEntry(current, fixedRate, "static", attempts, { keepLastGoodOnEmpty: true })));
  }
  return runSingleFlight(key, async () => {
    store.update(key, loadingEntry);
    const startedAt = Date.now();
    try {
      const snapshot = await dataProvider.getExchangeRateSnapshot?.(normalizedCurrency);
      const rate = snapshot?.rate ?? await dataProvider.getExchangeRate(normalizedCurrency);
      const metadata = exchangeRateMetadata(snapshot ?? rate, normalizedCurrency, Date.now(), Date.now());
      const source = snapshot?.source ?? dataProvider.id;
      const attempts = [createAttempt(source, startedAt, "success")];
      return store.update(key, (current) => {
        const entry = readyEntry(current, rate, source, attempts, { keepLastGoodOnEmpty: true });
        return { ...entry, ...metadata };
      });
    } catch (error) {
      const classified = classifyError(error);
      const attempt = createAttempt(dataProvider.id, startedAt, "fatal_error", classified.reasonCode, classified.message);
      return store.update(key, (current) => errorEntry(
        isUsableCachedExchangeRate(current.data ?? current.lastGoodData, normalizedCurrency, current)
          ? current : { ...current, data: null, lastGoodData: null }, attempt,
      ));
    }
  });
}

function loadAuxiliaryEntry<T>({
  dataProvider,
  coalesceRefresh = false,
  forceRefresh = false,
  key,
  store,
  ttlMs,
  runSingleFlight,
  load,
}: AuxiliaryLoaderOptions<T>): Promise<QueryEntry<T>> {
  const current = store.get(key);
  if (!forceRefresh && hasFreshReadyEntry(current, ttlMs)) {
    return Promise.resolve(current);
  }
  return runSingleFlight(forceRefresh && !coalesceRefresh ? `${key}|refresh` : key, async () => {
    store.update(key, loadingEntry);
    const startedAt = Date.now();
    try {
      return await load(startedAt);
    } catch (error) {
      const classified = classifyError(error);
      const attempt = createAttempt(dataProvider.id, startedAt, EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error", classified.reasonCode, classified.message);
      return store.update(key, (current) => errorEntry(current, attempt));
    }
  });
}
