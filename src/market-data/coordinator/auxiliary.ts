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
      const data = await dataProvider.getOptionsChain(
        request.instrument.symbol,
        request.instrument.exchange ?? "",
        request.expirationDate,
        toMarketDataContext(request.instrument),
      );
      const attempts = [createAttempt(dataProvider.id, startedAt, data.expirationDates.length > 0 ? "success" : "empty", data.expirationDates.length === 0 ? "NO_DATA" : undefined)];
      return store.update(key, (current) => readyEntry(current, data.expirationDates.length > 0 ? data : null, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadSecFilingsEntry(options: {
  dataProvider: DataProvider;
  request: SecFilingsRequest;
  store: QueryStore<SecFilingItem[]>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<SecFilingItem[]>> {
  const { dataProvider, request, store, runSingleFlight } = options;
  const key = buildSecFilingsKey(request);
  return loadAuxiliaryEntry({
    dataProvider,
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
        toMarketDataContext(request.instrument),
      );
      const attempts = [createAttempt(dataProvider.id, startedAt, data.length > 0 ? "success" : "empty", data.length === 0 ? "NO_DATA" : undefined)];
      return store.update(key, (current) => readyEntry(current, data.length > 0 ? data : null, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    },
  });
}

export function loadSecFilingContentEntry(options: {
  dataProvider: DataProvider;
  filing: SecFilingItem;
  store: QueryStore<string | null>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<string | null>> {
  const { dataProvider, filing, store, runSingleFlight } = options;
  const key = buildSecContentKey(filing.accessionNumber);
  return loadAuxiliaryEntry({
    dataProvider,
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
  filing: SecFilingItem;
  store: QueryStore<SecFilingDocument[]>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<SecFilingDocument[]>> {
  const { dataProvider, filing, store, runSingleFlight } = options;
  const key = buildSecDocumentsKey(filing.accessionNumber);
  return loadAuxiliaryEntry({
    dataProvider,
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
  store: QueryStore<number>;
  runSingleFlight: RunSingleFlight;
}): Promise<QueryEntry<number>> {
  const { dataProvider, store, runSingleFlight } = options;
  const normalizedCurrency = options.currency.trim().toUpperCase();
  const key = buildFxKey(normalizedCurrency);
  const current = store.get(key);
  if (hasFreshEntryData(current, FX_CACHE_TTL_MS)) {
    return Promise.resolve(current);
  }
  if (normalizedCurrency === "USD") {
    const startedAt = Date.now();
    const attempts = [createAttempt("static", startedAt, "success")];
    return Promise.resolve(store.update(key, (current) => readyEntry(current, 1, "static", attempts, { keepLastGoodOnEmpty: true })));
  }
  return runSingleFlight(key, async () => {
    store.update(key, loadingEntry);
    const startedAt = Date.now();
    try {
      const rate = await dataProvider.getExchangeRate(normalizedCurrency);
      const attempts = [createAttempt(dataProvider.id, startedAt, "success")];
      return store.update(key, (current) => readyEntry(current, rate, dataProvider.id, attempts, { keepLastGoodOnEmpty: true }));
    } catch (error) {
      const classified = classifyError(error);
      const attempt = createAttempt(dataProvider.id, startedAt, "fatal_error", classified.reasonCode, classified.message);
      return store.update(key, (current) => errorEntry(current, attempt));
    }
  });
}

function loadAuxiliaryEntry<T>({
  dataProvider,
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
  return runSingleFlight(forceRefresh ? `${key}|refresh` : key, async () => {
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
