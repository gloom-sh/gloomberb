import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SecFilingDocument, SecFilingItem } from "../types/data-provider";
import type { OptionsChain, PricePoint, Quote, TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { ChartRequest, InstrumentRef, OptionsRequest, SecFilingsRequest, TickerInstrumentOptions } from "./request-types";
import { instrumentFromTicker } from "./request-types";
import { useAppActive } from "../state/app/activity";
import {
  getSharedMarketDataCoordinator,
  resolveEntryValue,
} from "./coordinator";
import type { QueryEntry } from "./result-types";
import {
  buildArticleSummaryKey,
  buildChartKey,
  buildFxKey,
  buildOptionsKey,
  buildQuoteKey,
  buildSecContentKey,
  buildSecDocumentsKey,
  buildSecFilingsKey,
  buildSnapshotKey,
} from "./selectors";
import { createBaselineChartRequest } from "./coordinator/chart";

const TICKER_FINANCIALS_LOAD_DELAY_MS = 250;
export const DEFAULT_LIVE_CHART_REFRESH_INTERVAL_MS = 60_000;

interface ChartQueryOptions {
  debounceMs?: number;
  refreshIntervalMs?: number;
}

interface OptionsQueryOptions {
  refreshIntervalMs?: number;
}

type SharedCoordinator = NonNullable<ReturnType<typeof getSharedMarketDataCoordinator>>;

function loadChartRequests(
  coordinator: SharedCoordinator,
  requests: readonly ChartRequest[],
  options: { forceRefresh?: boolean } = {},
): void {
  for (const request of requests) {
    void coordinator.loadChart(request, options).catch(() => {});
  }
}

function useCoordinatorKeysVersion(keys: readonly string[]): number {
  const coordinator = getSharedMarketDataCoordinator();
  const keyString = keys.join("\u001f");
  const stableKeys = useMemo(
    () => (keyString ? keyString.split("\u001f") : []),
    [keyString],
  );
  const subscribe = useCallback((listener: () => void) => {
    if (!coordinator) return () => {};
    if (typeof coordinator.subscribeKeys === "function") {
      return coordinator.subscribeKeys(stableKeys, listener);
    }
    return coordinator.subscribe(listener);
  }, [coordinator, stableKeys]);
  const getSnapshot = useCallback(() => {
    if (!coordinator) return 0;
    if (typeof coordinator.getKeysVersion === "function") {
      return coordinator.getKeysVersion(stableKeys);
    }
    return coordinator.getVersion();
  }, [coordinator, stableKeys]);
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

function stableCurrencyList(currencies: Array<string | null | undefined>): string[] {
  return [...new Set(
    currencies
      .map((currency) => currency?.trim().toUpperCase() ?? "")
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

function buildTickerFinancialsMapKey(tickers: TickerRecord[], options: TickerInstrumentOptions = {}): string {
  return tickers.map((ticker) => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
    return [
      ticker.metadata.ticker,
      ticker.metadata.exchange ?? "",
      instrument?.brokerId ?? "",
      instrument?.brokerInstanceId ?? "",
      instrument?.instrument?.conId ?? "",
      instrument?.instrument?.localSymbol ?? "",
      instrument?.instrument?.symbol ?? "",
    ].join("|");
  }).join("::");
}

function useTickerInstrument(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): InstrumentRef | null {
  return useMemo(() => instrumentFromTicker(ticker, symbol ?? null), [symbol, ticker]);
}

export function useTickerFinancials(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): TickerFinancials | null {
  const instrument = useTickerInstrument(symbol, ticker);
  const keys = useMemo(() => (
    instrument
      ? [
        buildSnapshotKey(instrument),
        buildQuoteKey(instrument),
        buildChartKey(createBaselineChartRequest(instrument)),
      ]
      : []
  ), [instrument?.brokerId, instrument?.brokerInstanceId, instrument?.exchange, instrument?.instrument?.conId, instrument?.symbol]);
  useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const financials = coordinator && instrument
    ? coordinator.getTickerFinancialsSync(instrument)
    : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument) return;
    const timeoutId = setTimeout(() => {
      void coordinator.loadSnapshot(instrument).catch(() => {});
    }, TICKER_FINANCIALS_LOAD_DELAY_MS);
    return () => clearTimeout(timeoutId);
  }, [instrument?.brokerId, instrument?.brokerInstanceId, instrument?.exchange, instrument?.instrument?.conId, instrument?.symbol]);

  return financials;
}

function buildTickerFinancialsKeys(tickers: TickerRecord[], options: TickerInstrumentOptions = {}): string[] {
  const keys: string[] = [];
  for (const ticker of tickers) {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
    if (!instrument) continue;
    keys.push(
      buildSnapshotKey(instrument),
      buildQuoteKey(instrument),
      buildChartKey(createBaselineChartRequest(instrument)),
    );
  }
  return keys;
}

export function useTickerFinancialsMap(
  tickers: TickerRecord[],
  options: TickerInstrumentOptions = {},
): Map<string, TickerFinancials> {
  const coordinator = getSharedMarketDataCoordinator();
  const optionsKey = options.portfolioId ?? "";
  const tickerKey = buildTickerFinancialsMapKey(tickers, options);
  const subscriptionKeys = useMemo(() => buildTickerFinancialsKeys(tickers, options), [optionsKey, tickerKey]);
  const keysVersion = useCoordinatorKeysVersion(subscriptionKeys);

  return useMemo(() => {
    if (!coordinator) return new Map<string, TickerFinancials>();
    const result = new Map<string, TickerFinancials>();
    for (const ticker of tickers) {
      const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, options);
      if (!instrument) continue;
      const financials = coordinator.getTickerFinancialsSync(instrument);
      if (financials) {
        result.set(ticker.metadata.ticker, financials);
      }
    }
    return result;
  }, [coordinator, keysVersion, optionsKey, tickerKey, subscriptionKeys]);
}

export function useQuoteEntry(symbol: string | null | undefined, ticker: TickerRecord | null | undefined): QueryEntry<Quote> | null {
  const instrument = useTickerInstrument(symbol, ticker);
  const keys = useMemo(
    () => (instrument ? [buildQuoteKey(instrument)] : []),
    [instrument?.brokerId, instrument?.brokerInstanceId, instrument?.exchange, instrument?.instrument?.conId, instrument?.symbol],
  );
  useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && instrument ? coordinator.getQuoteEntry(instrument) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !instrument) return;
    void coordinator.loadQuote(instrument).catch(() => {});
  }, [instrument?.brokerId, instrument?.brokerInstanceId, instrument?.exchange, instrument?.instrument?.conId, instrument?.symbol]);

  return entry;
}

/**
 * Observe quote entries already populated by the shared stream without issuing
 * one HTTP snapshot request per instrument.
 */
export function useQuoteEntries(
  instruments: readonly InstrumentRef[],
): Map<string, QueryEntry<Quote>> {
  const instrumentKey = instruments
    .map((instrument) => buildQuoteKey(instrument))
    .join("\u001f");
  const keys = useMemo(
    () => instruments.map((instrument) => buildQuoteKey(instrument)),
    [instrumentKey],
  );
  const keysVersion = useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();

  return useMemo(() => {
    if (!coordinator) return new Map<string, QueryEntry<Quote>>();
    return new Map(
      instruments.map((instrument) => [
        buildQuoteKey(instrument),
        coordinator.getQuoteEntry(instrument),
      ]),
    );
  }, [coordinator, instrumentKey, keysVersion]);
}

export function useChartQueries(
  requests: readonly ChartRequest[],
  options: ChartQueryOptions = {},
): Map<string, QueryEntry<PricePoint[]>> {
  const requestKey = requests.map((request) => buildChartKey(request)).join(",");
  const debounceMs = Math.max(0, options.debounceMs ?? 0);
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 0);
  const keys = useMemo(() => requests.map((request) => buildChartKey(request)), [requestKey]);
  const keysVersion = useCoordinatorKeysVersion(keys);
  const coordinator = getSharedMarketDataCoordinator();
  const appActive = useAppActive();
  const wasActiveRef = useRef(appActive);
  const entries = useMemo(() => (
    coordinator
      ? requests.map((request) => [buildChartKey(request), coordinator.getChartEntry(request)] as const)
      : [] as Array<readonly [string, QueryEntry<PricePoint[]>]>
  ), [coordinator, keys, keysVersion, requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) {
      wasActiveRef.current = appActive;
      return;
    }
    if (!appActive) {
      wasActiveRef.current = false;
      return;
    }
    const forceRefresh = refreshIntervalMs > 0 && !wasActiveRef.current;
    wasActiveRef.current = true;
    const loadRequests = () => {
      loadChartRequests(coordinator, requests, { forceRefresh });
    };
    if (debounceMs <= 0) {
      loadRequests();
      return;
    }
    const timeout = setTimeout(loadRequests, debounceMs);
    return () => clearTimeout(timeout);
  }, [appActive, debounceMs, refreshIntervalMs, requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !appActive || refreshIntervalMs <= 0 || requests.length === 0) return;

    const interval = setInterval(() => {
      loadChartRequests(coordinator, requests, { forceRefresh: true });
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [appActive, refreshIntervalMs, requestKey]);

  return useMemo(() => new Map(entries), [entries]);
}

export function useOptionsQuery(
  request: OptionsRequest | null | undefined,
  options: OptionsQueryOptions = {},
): QueryEntry<OptionsChain> | null {
  const requestKey = request ? buildOptionsKey(request) : null;
  useCoordinatorKeysVersion(requestKey ? [requestKey] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && request ? coordinator.getOptionsEntry(request) : null;
  const appActive = useAppActive();
  const refreshIntervalMs = Math.max(0, options.refreshIntervalMs ?? 0);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request) return;
    void coordinator.loadOptions(request).catch(() => {});
  }, [requestKey]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request || !appActive || refreshIntervalMs <= 0) return;
    const interval = setInterval(() => {
      void coordinator.loadOptions(request, { forceRefresh: true }).catch(() => {});
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [appActive, refreshIntervalMs, requestKey]);

  return entry;
}

export function useSecFilingsQuery(request: SecFilingsRequest | null | undefined): QueryEntry<SecFilingItem[]> | null {
  const requestKey = request ? buildSecFilingsKey(request) : null;
  useCoordinatorKeysVersion(requestKey ? [requestKey] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && request ? coordinator.getSecFilingsEntry(request) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !request) return;
    void coordinator.loadSecFilings(request).catch(() => {});
  }, [requestKey]);

  return entry;
}

export function useSecFilingContent(filing: SecFilingItem | null | undefined): QueryEntry<string | null> | null {
  const key = filing ? buildSecContentKey(filing.accessionNumber) : null;
  useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && filing ? coordinator.getSecContentEntry(filing.accessionNumber) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !filing) return;
    void coordinator.loadSecFilingContent(filing).catch(() => {});
  }, [key]);

  return entry;
}

export function useSecFilingDocuments(filing: SecFilingItem | null | undefined): QueryEntry<SecFilingDocument[]> | null {
  const key = filing ? buildSecDocumentsKey(filing.accessionNumber) : null;
  useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && filing ? coordinator.getSecDocumentsEntry(filing.accessionNumber) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !filing) return;
    void coordinator.loadSecFilingDocuments(filing).catch(() => {});
  }, [key]);

  return entry;
}

export function useArticleSummary(url: string | null | undefined): QueryEntry<string | null> | null {
  const key = url ? buildArticleSummaryKey(url) : null;
  useCoordinatorKeysVersion(key ? [key] : []);
  const coordinator = getSharedMarketDataCoordinator();
  const entry = coordinator && url ? coordinator.getArticleSummaryEntry(url) : null;

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator || !url) return;
    void coordinator.loadArticleSummary(url).catch(() => {});
  }, [url]);

  return entry;
}

export function useFxRatesMap(currencies: Array<string | null | undefined>): Map<string, number> {
  const coordinator = getSharedMarketDataCoordinator();
  const normalizedCurrencyKey = stableCurrencyList(currencies).join("|");
  const normalizedCurrencies = useMemo(
    () => (normalizedCurrencyKey ? normalizedCurrencyKey.split("|") : []),
    [normalizedCurrencyKey],
  );
  const keys = useMemo(() => normalizedCurrencies.map(buildFxKey), [normalizedCurrencies]);
  const keysVersion = useCoordinatorKeysVersion(keys);
  const entries = useMemo(() => {
    if (!coordinator) return [] as Array<readonly [string, QueryEntry<number>]>;
    return normalizedCurrencies.map((currency) => [currency, coordinator.getFxEntry(currency)] as const);
  }, [coordinator, keys, keysVersion, normalizedCurrencies]);

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    for (const currency of normalizedCurrencies) {
      if (currency === "USD") continue;
      void coordinator.loadFxRate(currency);
    }
  }, [normalizedCurrencyKey]);

  return useMemo(() => {
    const rates = new Map<string, number>();
    rates.set("USD", 1);
    for (const [currency, entry] of entries) {
      const rate = resolveEntryValue(entry);
      if (rate != null) {
        rates.set(currency, rate);
      }
    }
    return rates;
  }, [entries]);
}

export function useResolvedEntryValue<T>(entry: QueryEntry<T> | null | undefined): T | null {
  return useMemo(() => (entry ? resolveEntryValue(entry) : null), [entry]);
}
