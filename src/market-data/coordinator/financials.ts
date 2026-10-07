import type { CachedFinancialsTarget, DataProvider } from "../../types/data-provider";
import type { PricePoint, Quote, TickerFinancials } from "../../types/financials";
import type { ChartRequest, InstrumentRef } from "../request-types";
import type { ProviderAttempt, QueryEntry } from "../result-types";
import { normalizeTickerFinancialsPriceHistory } from "../../utils/price-history";
import { QueryStore } from "../query-store";
import {
  buildChartKey,
  buildQuoteKey,
  buildSnapshotKey,
  toMarketDataContext,
} from "../selectors";
import { traceMarketData } from "../trace";
import { createBaselineChartRequest } from "./chart";
import {
  EXPECTED_EMPTY,
  SNAPSHOT_CACHE_TTL_MS,
  SNAPSHOT_FAILURE_RETRY_MS,
  classifyError,
  createAttempt,
  errorEntry,
  hasCachedSnapshotData,
  hasFreshEntryData,
  hasRecentFailedAttempt,
  heldQuoteSupersedes,
  loadingEntry,
  readyEntry,
  readyChartEntry,
} from "./entries";

export interface FinancialCacheStores {
  quoteStore: QueryStore<Quote>;
  snapshotStore: QueryStore<TickerFinancials>;
  chartStore: QueryStore<PricePoint[]>;
}

function cachedFinancialsTargetFromInstrument(instrument: InstrumentRef): CachedFinancialsTarget {
  return {
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    brokerId: instrument.brokerId,
    brokerInstanceId: instrument.brokerInstanceId,
    instrument: instrument.instrument ?? null,
  };
}

export function primeFinancialsCache(
  stores: FinancialCacheStores,
  instrument: InstrumentRef,
  financials: TickerFinancials,
  fallbackSource: string,
): void {
  const normalized = normalizeTickerFinancialsPriceHistory(financials);
  const source = normalized.quote?.providerId ?? fallbackSource;
  const snapshotKey = buildSnapshotKey(instrument);
  const quoteKey = buildQuoteKey(instrument);

  if (hasCachedSnapshotData(normalized) && stores.snapshotStore.get(snapshotKey).phase === "idle") {
    stores.snapshotStore.set(
      snapshotKey,
      readyEntry(stores.snapshotStore.get(snapshotKey), normalized, source, [], { keepLastGoodOnEmpty: true }),
    );
  }
  if (normalized.quote && stores.quoteStore.get(quoteKey).phase === "idle") {
    stores.quoteStore.set(
      quoteKey,
      readyEntry(stores.quoteStore.get(quoteKey), normalized.quote, normalized.quote.providerId ?? source, []),
    );
  }
  if (normalized.priceHistory.length > 0) {
    const chartRequest = createBaselineChartRequest(instrument);
    const chartKey = buildChartKey(chartRequest);
    if (stores.chartStore.get(chartKey).phase === "idle") {
      stores.chartStore.set(
        chartKey,
        readyChartEntry(stores.chartStore.get(chartKey), normalized.priceHistory, source, []),
      );
    }
  }
}

function storeFinancialsSnapshot(
  stores: FinancialCacheStores,
  instrument: InstrumentRef,
  data: TickerFinancials,
  source: string,
  attempts: ProviderAttempt[],
): QueryEntry<TickerFinancials> {
  const normalized = normalizeTickerFinancialsPriceHistory(data);
  const snapshotKey = buildSnapshotKey(instrument);
  const entry = stores.snapshotStore.update(snapshotKey, (current) =>
    readyEntry(current, normalized, source, attempts, { keepLastGoodOnEmpty: true })
  );
  if (normalized.quote) {
    const quoteKey = buildQuoteKey(instrument);
    const currentQuoteEntry = stores.quoteStore.get(quoteKey);
    // A tick streamed while the snapshot was in flight is newer than its quote.
    if (!heldQuoteSupersedes(currentQuoteEntry, normalized.quote)) {
      stores.quoteStore.set(
        quoteKey,
        readyEntry(currentQuoteEntry, normalized.quote, normalized.quote.providerId ?? source, attempts),
      );
    }
  }
  if ((normalized.priceHistory ?? []).length > 0) {
    const chartRequest: ChartRequest = createBaselineChartRequest(instrument);
    stores.chartStore.set(
      buildChartKey(chartRequest),
      readyEntry(stores.chartStore.get(buildChartKey(chartRequest)), normalized.priceHistory, source, attempts, { keepLastGoodOnEmpty: true }),
    );
  }
  return entry;
}

/** Fresh data, or a failure too recent to ask about again unless forced. */
function canReuseSnapshotEntry(entry: QueryEntry<TickerFinancials>): boolean {
  return hasFreshEntryData(entry, SNAPSHOT_CACHE_TTL_MS) || hasRecentFailedAttempt(entry, SNAPSHOT_FAILURE_RETRY_MS);
}

function storeFinancialsFailure(
  stores: FinancialCacheStores,
  key: string,
  providerId: string,
  startedAt: number,
  error: unknown,
): QueryEntry<TickerFinancials> {
  const classified = classifyError(error);
  const status = EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error";
  const attempt = createAttempt(providerId, startedAt, status, classified.reasonCode, classified.message);
  return stores.snapshotStore.update(key, (current) => errorEntry(current, attempt));
}

type CoordinatorSingleFlight = <T>(key: string, task: () => Promise<T>) => Promise<T>;
type CoordinatorLoadOptions = { forceRefresh?: boolean };

interface LoadFinancialsSnapshotEntryOptions {
  dataProvider: DataProvider;
  instrument: InstrumentRef;
  options?: CoordinatorLoadOptions;
  runSingleFlight: CoordinatorSingleFlight;
  stores: FinancialCacheStores;
}

export async function loadFinancialsSnapshotEntry({
  dataProvider,
  instrument,
  options = {},
  runSingleFlight,
  stores,
}: LoadFinancialsSnapshotEntryOptions): Promise<QueryEntry<TickerFinancials>> {
  const key = buildSnapshotKey(instrument);
  const current = stores.snapshotStore.get(key);
  if (!options.forceRefresh && canReuseSnapshotEntry(current)) {
    return current;
  }
  const flightKey = options.forceRefresh ? `${key}|refresh` : key;
  return runSingleFlight(flightKey, async () => {
    stores.snapshotStore.update(key, loadingEntry);
    const startedAt = Date.now();
    traceMarketData("snapshot:start", { key, symbol: instrument.symbol, exchange: instrument.exchange ?? "" });
    try {
      const data = await dataProvider.getTickerFinancials(
        instrument.symbol,
        instrument.exchange ?? "",
        {
          ...toMarketDataContext(instrument),
          cacheMode: options.forceRefresh ? "refresh" : "default",
        },
      );
      const source = data.quote?.providerId ?? dataProvider.id;
      const attempts = [createAttempt(source, startedAt, data ? "success" : "empty")];
      const entry = storeFinancialsSnapshot(stores, instrument, data, source, attempts);
      traceMarketData("snapshot:ready", {
        key,
        symbol: instrument.symbol,
        source,
        priceHistory: data.priceHistory.length,
      });
      return entry;
    } catch (error) {
      traceMarketData("snapshot:error", { key, symbol: instrument.symbol, ...classifyError(error) });
      return storeFinancialsFailure(stores, key, dataProvider.id, startedAt, error);
    }
  });
}

interface LoadFinancialsSnapshotBatchOptions {
  dataProvider: DataProvider;
  instruments: InstrumentRef[];
  options?: CoordinatorLoadOptions;
  runSingleFlight: CoordinatorSingleFlight;
  stores: FinancialCacheStores;
}

export async function loadFinancialsSnapshotBatch({
  dataProvider,
  instruments,
  options = {},
  runSingleFlight,
  stores,
}: LoadFinancialsSnapshotBatchOptions): Promise<QueryEntry<TickerFinancials>[]> {
  const uniqueInstruments = [...new Map(instruments.map((instrument) => [buildSnapshotKey(instrument), instrument] as const)).values()];
  const results = new Map<string, QueryEntry<TickerFinancials>>();
  const misses: InstrumentRef[] = [];

  for (const instrument of uniqueInstruments) {
    const key = buildSnapshotKey(instrument);
    const current = stores.snapshotStore.get(key);
    if (!options.forceRefresh && canReuseSnapshotEntry(current)) {
      results.set(key, current);
    } else {
      misses.push(instrument);
    }
  }

  if (misses.length > 0 && dataProvider.getTickerFinancialsBatch) {
    const startedAt = Date.now();
    const batchResults = await dataProvider.getTickerFinancialsBatch(
      misses.map((instrument) => cachedFinancialsTargetFromInstrument(instrument)),
      { forceRefresh: options.forceRefresh },
    );
    batchResults.forEach((item, index) => {
      const instrument = misses[index];
      if (!instrument) return;
      const key = buildSnapshotKey(instrument);
      if (!item.financials) {
        // The batch already asked for this one, one by one where the batch
        // answer fell short, and says why it failed. Asking again here would
        // only send the same request a second time.
        if (item.error != null) results.set(key, storeFinancialsFailure(stores, key, dataProvider.id, startedAt, item.error));
        return;
      }
      const source = item.financials.quote?.providerId ?? dataProvider.id;
      const attempts = [createAttempt(source, Date.now(), "success")];
      results.set(key, storeFinancialsSnapshot(stores, instrument, item.financials, source, attempts));
    });
  }

  await Promise.all(misses.map(async (instrument) => {
    const key = buildSnapshotKey(instrument);
    if (results.has(key)) return;
    results.set(key, await loadFinancialsSnapshotEntry({
      dataProvider,
      instrument,
      options,
      runSingleFlight,
      stores,
    }));
  }));

  return instruments.map((instrument) => results.get(buildSnapshotKey(instrument)) ?? stores.snapshotStore.get(buildSnapshotKey(instrument)));
}
