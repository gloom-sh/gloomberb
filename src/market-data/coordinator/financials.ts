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
  classifyError,
  createAttempt,
  errorEntry,
  hasCachedSnapshotData,
  hasFreshEntryData,
  loadingEntry,
  readyEntry,
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
        readyEntry(stores.chartStore.get(chartKey), normalized.priceHistory, source, [], { keepLastGoodOnEmpty: true }),
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
    stores.quoteStore.set(
      quoteKey,
      readyEntry(stores.quoteStore.get(quoteKey), normalized.quote, normalized.quote.providerId ?? source, attempts),
    );
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
  if (!options.forceRefresh && hasFreshEntryData(current, SNAPSHOT_CACHE_TTL_MS)) {
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
      const classified = classifyError(error);
      const status = EXPECTED_EMPTY.test(classified.message) ? "empty" : "fatal_error";
      const attempt = createAttempt(dataProvider.id, startedAt, status, classified.reasonCode, classified.message);
      traceMarketData("snapshot:error", { key, symbol: instrument.symbol, ...classified });
      return stores.snapshotStore.update(key, (current) => errorEntry(current, attempt));
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
    if (!options.forceRefresh && hasFreshEntryData(current, SNAPSHOT_CACHE_TTL_MS)) {
      results.set(key, current);
    } else {
      misses.push(instrument);
    }
  }

  if (misses.length > 0 && dataProvider.getTickerFinancialsBatch) {
    const batchResults = await dataProvider.getTickerFinancialsBatch(
      misses.map((instrument) => cachedFinancialsTargetFromInstrument(instrument)),
      { forceRefresh: options.forceRefresh },
    );
    batchResults.forEach((item, index) => {
      const instrument = misses[index];
      if (!instrument || !item.financials) return;
      const key = buildSnapshotKey(instrument);
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
