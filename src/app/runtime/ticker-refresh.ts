import { useCallback, useEffect, useRef, type Dispatch } from "react";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import { instrumentFromTicker, type InstrumentRef } from "../../market-data/request-types";
import { instrumentIdentityKey } from "../../utils/instrument-identity";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppAction } from "../../state/app/context";
import type { InitializeAppStateArgs } from "../../state/app/bootstrap";
import { TickerRefreshQueue } from "../../state/ticker-refresh-queue";
import type { TickerRecord } from "../../types/ticker";

const refreshInFlight: Set<string> = (globalThis as any).__refreshInFlight ??= new Set<string>();
const quoteRefreshInFlight: Set<string> = (globalThis as any).__quoteRefreshInFlight ??= new Set<string>();
const refreshingSymbols: Map<string, number> = (globalThis as any).__refreshingSymbols ??= new Map<string, number>();

type RefreshEntry = { ticker: TickerRecord; priority: number; instrument?: InstrumentRef };
type InstrumentRefreshEntry = RefreshEntry & { instrument: InstrumentRef; key: string };

export interface AppTickerRefreshRuntime {
  primeCachedFinancials: NonNullable<InitializeAppStateArgs["primeCachedFinancials"]>;
  refreshQuote: InitializeAppStateArgs["refreshQuote"];
  refreshQuotesBatch: NonNullable<InitializeAppStateArgs["refreshQuotesBatch"]>;
  refreshTicker: InitializeAppStateArgs["refreshTicker"];
  refreshTickersBatch: NonNullable<InitializeAppStateArgs["refreshTickersBatch"]>;
}

function resolveRefreshEntries(entries: RefreshEntry[]): InstrumentRefreshEntry[] {
  const targets = new Map<string, InstrumentRefreshEntry>();
  for (const entry of entries) {
    const instrument = entry.instrument ?? instrumentFromTicker(entry.ticker, entry.ticker.metadata.ticker);
    if (!instrument) continue;
    const key = instrumentIdentityKey(instrument);
    const previous = targets.get(key);
    targets.set(key, { ...entry, instrument, key, priority: Math.min(previous?.priority ?? entry.priority, entry.priority) });
  }
  return [...targets.values()];
}

export function useTickerRefreshRuntime({
  appVisible,
  baseCurrency,
  dispatch,
  marketData,
  pluginRegistry,
  tickers,
}: {
  /** Refreshes run while the app can be seen, focused or not. */
  appVisible: boolean;
  baseCurrency: string;
  dispatch: Dispatch<AppAction>;
  marketData: MarketDataCoordinator;
  pluginRegistry: PluginRegistry;
  tickers: Map<string, TickerRecord>;
}): AppTickerRefreshRuntime {
  const refreshQueueRef = useRef({ queue: new TickerRefreshQueue(3) });
  const pendingRefreshesRef = useRef({ financials: new Set<string>(), quotes: new Set<string>() });

  useEffect(() => {
    refreshQueueRef.current.queue.setPaused(!appVisible);
  }, [appVisible]);

  const setRefreshing = useCallback((symbol: string, active: boolean) => {
    const count = Math.max(0, (refreshingSymbols.get(symbol) ?? 0) + (active ? 1 : -1));
    if (count) refreshingSymbols.set(symbol, count);
    else refreshingSymbols.delete(symbol);
    dispatch({ type: "SET_REFRESHING", symbol, refreshing: count > 0 });
  }, [dispatch]);

  const performRefreshTicker = useCallback(async (instrument: InstrumentRef) => {
    const key = instrumentIdentityKey(instrument);
    if (refreshInFlight.has(key)) return;
    refreshInFlight.add(key);
    setRefreshing(instrument.symbol, true);
    try {
      const entry = await marketData.loadSnapshot(instrument, { forceRefresh: true });
      const data = entry.data ?? entry.lastGoodData;
      if (data) pluginRegistry.events.emit("ticker:refreshed", { symbol: instrument.symbol, financials: data });
      const currency = data?.quote?.currency;
      if (currency) void marketData.loadFxRate(currency).catch(() => {});
      void marketData.loadFxRate(baseCurrency).catch(() => {});
    } catch {
      // Silently fail - will show "—" for missing data.
    } finally {
      refreshInFlight.delete(key);
      setRefreshing(instrument.symbol, false);
    }
  }, [baseCurrency, marketData, pluginRegistry.events, setRefreshing]);

  const performRefreshQuote = useCallback(async (instrument: InstrumentRef) => {
    const key = instrumentIdentityKey(instrument);
    if (refreshInFlight.has(key) || quoteRefreshInFlight.has(key)) return;
    quoteRefreshInFlight.add(key);
    try {
      const entry = await marketData.loadQuote(instrument, { forceRefresh: true });
      const quote = entry.data ?? entry.lastGoodData;
      if (!quote) return;
      if (quote.currency) void marketData.loadFxRate(quote.currency).catch(() => {});
      void marketData.loadFxRate(baseCurrency).catch(() => {});
    } catch {
      // Silently fail - the list can fall back to stale cache or Yahoo.
    } finally {
      quoteRefreshInFlight.delete(key);
    }
  }, [baseCurrency, marketData]);

  const refreshTicker = useCallback<AppTickerRefreshRuntime["refreshTicker"]>((symbol, _exchange = "", tickerOverride, priority = 2, target) => {
    const instrument = target ?? instrumentFromTicker(tickerOverride ?? tickers.get(symbol), symbol);
    if (!instrument) return;
    const key = instrumentIdentityKey(instrument);
    if (refreshInFlight.has(key) || pendingRefreshesRef.current.financials.has(key)) return;
    pendingRefreshesRef.current.financials.add(key);
    refreshQueueRef.current.queue.enqueue({
      key: `financials:${key}`, priority,
      run: async () => {
        try { await performRefreshTicker(instrument); }
        finally { pendingRefreshesRef.current.financials.delete(key); }
      },
    });
  }, [performRefreshTicker, tickers]);

  const refreshQuote = useCallback<AppTickerRefreshRuntime["refreshQuote"]>((symbol, _exchange = "", tickerOverride, priority = 2, target) => {
    const instrument = target ?? instrumentFromTicker(tickerOverride ?? tickers.get(symbol), symbol);
    if (!instrument) return;
    const key = instrumentIdentityKey(instrument);
    if (refreshInFlight.has(key) || quoteRefreshInFlight.has(key)
      || pendingRefreshesRef.current.financials.has(key) || pendingRefreshesRef.current.quotes.has(key)) return;
    pendingRefreshesRef.current.quotes.add(key);
    refreshQueueRef.current.queue.enqueue({
      key: `quote:${key}`, priority,
      run: async () => {
        try {
          if (pendingRefreshesRef.current.financials.has(key) || refreshInFlight.has(key)) return;
          await performRefreshQuote(instrument);
        } finally { pendingRefreshesRef.current.quotes.delete(key); }
      },
    });
  }, [performRefreshQuote, tickers]);

  const refreshTickersBatch = useCallback((entries: RefreshEntry[]) => {
    const runnable = resolveRefreshEntries(entries).filter(({ key }) => !refreshInFlight.has(key) && !pendingRefreshesRef.current.financials.has(key));
    if (runnable.length === 0) return;
    for (const { key } of runnable) pendingRefreshesRef.current.financials.add(key);
    const priority = Math.min(...runnable.map((entry) => entry.priority));
    refreshQueueRef.current.queue.enqueue({
      key: `financials-batch:${priority}:${runnable.map(({ key }) => key).join(",")}`, priority,
      run: async () => {
        for (const { instrument, key } of runnable) {
          refreshInFlight.add(key);
          setRefreshing(instrument.symbol, true);
        }
        try {
          const results = await marketData.loadSnapshotsBatch(runnable.map(({ instrument }) => instrument), { forceRefresh: true });
          results.forEach((entry, index) => {
            const instrument = runnable[index]?.instrument;
            const data = entry.data ?? entry.lastGoodData;
            if (instrument && data) {
              pluginRegistry.events.emit("ticker:refreshed", { symbol: instrument.symbol, financials: data });
              if (data.quote?.currency) void marketData.loadFxRate(data.quote.currency).catch(() => {});
            }
          });
          void marketData.loadFxRate(baseCurrency).catch(() => {});
        } finally {
          for (const { instrument, key } of runnable) {
            refreshInFlight.delete(key);
            pendingRefreshesRef.current.financials.delete(key);
            setRefreshing(instrument.symbol, false);
          }
        }
      },
    });
  }, [baseCurrency, marketData, pluginRegistry.events, setRefreshing]);

  const refreshQuotesBatch = useCallback((entries: RefreshEntry[]) => {
    const runnable = resolveRefreshEntries(entries).filter(({ key }) => !refreshInFlight.has(key) && !quoteRefreshInFlight.has(key)
      && !pendingRefreshesRef.current.financials.has(key) && !pendingRefreshesRef.current.quotes.has(key));
    if (runnable.length === 0) return;
    for (const { key } of runnable) pendingRefreshesRef.current.quotes.add(key);
    const priority = Math.min(...runnable.map((entry) => entry.priority));
    refreshQueueRef.current.queue.enqueue({
      key: `quotes-batch:${priority}:${runnable.map(({ key }) => key).join(",")}`, priority,
      run: async () => {
        for (const { key } of runnable) quoteRefreshInFlight.add(key);
        try {
          const results = await marketData.loadQuotesBatch(runnable.map(({ instrument }) => instrument));
          for (const entry of results) {
            const quote = entry.data ?? entry.lastGoodData;
            if (quote?.currency) void marketData.loadFxRate(quote.currency).catch(() => {});
          }
          void marketData.loadFxRate(baseCurrency).catch(() => {});
        } finally {
          for (const { key } of runnable) {
            quoteRefreshInFlight.delete(key);
            pendingRefreshesRef.current.quotes.delete(key);
          }
        }
      },
    });
  }, [baseCurrency, marketData]);

  const primeCachedFinancials = useCallback<AppTickerRefreshRuntime["primeCachedFinancials"]>((entries) => {
    // Cache ownership was established by the exact queried startup target.
    if (entries.length) marketData.primeCachedFinancials(entries);
  }, [marketData]);

  return { primeCachedFinancials, refreshQuote, refreshQuotesBatch, refreshTicker, refreshTickersBatch };
}
