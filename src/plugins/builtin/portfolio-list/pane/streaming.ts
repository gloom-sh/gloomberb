import { useEffect, useMemo, useRef } from "react";
import { getSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { instrumentFromTicker, quoteSubscriptionTargetFromTicker } from "../../../../market-data/request-types";
import { useQuoteUpdates } from "../../../../state/hooks/quote-streaming";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import type { CollectionSortPreference } from "../../../../state/app/context";
import {
  VISIBLE_FINANCIAL_WARMUP_DELAY_MS,
  VISIBLE_QUOTE_REFRESH_COOLDOWN_MS,
  VISIBLE_QUOTE_STREAM_WATCHDOG_MS,
  VISIBLE_SNAPSHOT_WARMUP_BATCH_LIMIT,
  VISIBLE_SNAPSHOT_REFRESH_COOLDOWN_MS,
  SORT_QUOTE_WARMUP_BATCH_LIMIT,
  needsVisibleQuoteWarmup,
  needsVisibleQuoteWatchdogRefresh,
  needsVisibleSnapshotWarmup,
  selectQuoteWarmupTickers,
  selectStreamTickers,
  sortPreferenceUsesQuote,
  visibleWarmupKey,
  type VisibleWarmupRequirements,
} from "./data";

export function usePortfolioPaneStreaming({
  appActive,
  activeCollectionId,
  sortedTickers,
  cursorSymbol,
  streamWindow,
  isPortfolioTab,
  activeSort,
  financialsMap,
  visibleWarmupRequirements,
  liveStreaming,
}: {
  appActive: boolean;
  activeCollectionId?: string;
  sortedTickers: TickerRecord[];
  cursorSymbol: string | null;
  streamWindow: { start: number; end: number };
  isPortfolioTab: boolean;
  activeSort: CollectionSortPreference;
  financialsMap: Map<string, TickerFinancials>;
  visibleWarmupRequirements: VisibleWarmupRequirements;
  liveStreaming: boolean;
}) {
  const sharedCoordinator = getSharedMarketDataCoordinator();
  const mountedRef = useRef(true);
  const warmupInFlightRef = useRef(new Set<string>());
  const warmupAttemptRef = useRef(new Map<string, number>());

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const streamTickers = useMemo(
    () => selectStreamTickers(sortedTickers, streamWindow, cursorSymbol),
    [cursorSymbol, sortedTickers, streamWindow],
  );
  const priorityStreamSymbols = useMemo(
    () => new Set(streamTickers.map((ticker) => ticker.metadata.ticker)),
    [streamTickers],
  );
  const streamSurface: "portfolio" | "watchlist" = isPortfolioTab ? "portfolio" : "watchlist";
  const instrumentOptions = useMemo(() => ({
    portfolioId: isPortfolioTab ? activeCollectionId : undefined,
  }), [activeCollectionId, isPortfolioTab]);
  const streamTargets = useMemo(() => (
    sortedTickers
      .map((ticker) => {
        const target = quoteSubscriptionTargetFromTicker(ticker, ticker.metadata.ticker, "provider", instrumentOptions);
        if (!target) return null;
        const selected = ticker.metadata.ticker === cursorSymbol;
        const visible = priorityStreamSymbols.has(ticker.metadata.ticker);
        return {
          ...target,
          surface: streamSurface,
          visible,
          selected,
          weight: selected ? 100 : visible ? 80 : 10,
        };
      })
      .filter((target): target is NonNullable<typeof target> => target != null)
  ), [cursorSymbol, instrumentOptions, priorityStreamSymbols, sortedTickers, streamSurface]);
  const visibleFinancialTickers = useMemo(
    () => sortedTickers.slice(streamWindow.start, streamWindow.end),
    [sortedTickers, streamWindow.end, streamWindow.start],
  );
  const watchdogInputsRef = useRef<{
    financialsMap: Map<string, TickerFinancials>;
    instrumentOptions: typeof instrumentOptions;
    visibleFinancialTickers: TickerRecord[];
  }>({ financialsMap, instrumentOptions, visibleFinancialTickers });

  useEffect(() => {
    watchdogInputsRef.current = {
      financialsMap,
      instrumentOptions,
      visibleFinancialTickers,
    };
  }, [financialsMap, instrumentOptions, visibleFinancialTickers]);

  useEffect(() => {
    if (!appActive) return;
    if (!sharedCoordinator) return;

    const nowTimestamp = Date.now();
    const quoteQueue: TickerRecord[] = [];
    const quoteSnapshotQueue: TickerRecord[] = [];
    const snapshotQueue: TickerRecord[] = [];
    const snapshotQueueSymbols = new Set<string>();
    const useSnapshotForQuoteWarmup = liveStreaming && sortPreferenceUsesQuote(activeSort);
    const quoteWarmupTickers = liveStreaming
      ? selectQuoteWarmupTickers(
        sortedTickers,
        streamWindow,
        financialsMap,
        activeSort,
        nowTimestamp,
      )
      : [];
    for (const ticker of quoteWarmupTickers) {
      const financials = financialsMap.get(ticker.metadata.ticker);
      const quoteKey = visibleWarmupKey("quote", ticker);
      const warmupWithSnapshot = useSnapshotForQuoteWarmup && ticker.metadata.assetCategory !== "OPT";
      const warmupKey = warmupWithSnapshot ? visibleWarmupKey("snapshot", ticker) : quoteKey;
      if (
        needsVisibleQuoteWarmup(financials, nowTimestamp)
        && !warmupInFlightRef.current.has(warmupKey)
        && nowTimestamp - (warmupAttemptRef.current.get(warmupKey) ?? 0) >= VISIBLE_QUOTE_REFRESH_COOLDOWN_MS
      ) {
        if (warmupWithSnapshot) {
          quoteSnapshotQueue.push(ticker);
          snapshotQueueSymbols.add(ticker.metadata.ticker);
        } else {
          quoteQueue.push(ticker);
        }
      }
    }

    for (const ticker of visibleFinancialTickers) {
      const financials = financialsMap.get(ticker.metadata.ticker);
      if (snapshotQueueSymbols.has(ticker.metadata.ticker)) continue;
      const snapshotKey = visibleWarmupKey("snapshot", ticker);
      if (
        needsVisibleSnapshotWarmup(ticker, financials, visibleWarmupRequirements)
        && !warmupInFlightRef.current.has(snapshotKey)
        && nowTimestamp - (warmupAttemptRef.current.get(snapshotKey) ?? 0) >= VISIBLE_SNAPSHOT_REFRESH_COOLDOWN_MS
      ) {
        snapshotQueue.push(ticker);
        snapshotQueueSymbols.add(ticker.metadata.ticker);
      }
    }
    const limitedQuoteSnapshotQueue = quoteSnapshotQueue.slice(0, SORT_QUOTE_WARMUP_BATCH_LIMIT);
    const limitedSnapshotQueue = snapshotQueue.slice(0, VISIBLE_SNAPSHOT_WARMUP_BATCH_LIMIT);
    if (quoteQueue.length === 0 && limitedQuoteSnapshotQueue.length === 0 && limitedSnapshotQueue.length === 0) return;

    let cancelled = false;
    const runBatch = async (): Promise<void> => {
      const quoteEntries = quoteQueue.flatMap((ticker) => {
        const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, instrumentOptions);
        if (!instrument) return [];
        const key = visibleWarmupKey("quote", ticker);
        warmupInFlightRef.current.add(key);
        warmupAttemptRef.current.set(key, nowTimestamp);
        return [{ key, instrument }];
      });
      const forcedSnapshotEntries = limitedQuoteSnapshotQueue.flatMap((ticker) => {
        const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, instrumentOptions);
        if (!instrument) return [];
        const key = visibleWarmupKey("snapshot", ticker);
        warmupInFlightRef.current.add(key);
        warmupAttemptRef.current.set(key, nowTimestamp);
        return [{ key, instrument }];
      });
      const normalSnapshotEntries = limitedSnapshotQueue.flatMap((ticker) => {
        const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, instrumentOptions);
        if (!instrument) return [];
        const key = visibleWarmupKey("snapshot", ticker);
        warmupInFlightRef.current.add(key);
        warmupAttemptRef.current.set(key, nowTimestamp);
        return [{ key, instrument }];
      });
      if (quoteEntries.length === 0 && forcedSnapshotEntries.length === 0 && normalSnapshotEntries.length === 0) return;
      try {
        await Promise.allSettled([
          quoteEntries.length > 0
            ? sharedCoordinator.loadQuotesBatch(quoteEntries.map((entry) => entry.instrument), { forceRefresh: true })
            : Promise.resolve(),
          forcedSnapshotEntries.length > 0
            ? sharedCoordinator.loadSnapshotsBatch(forcedSnapshotEntries.map((entry) => entry.instrument), { forceRefresh: true })
            : Promise.resolve(),
          normalSnapshotEntries.length > 0
            ? sharedCoordinator.loadSnapshotsBatch(normalSnapshotEntries.map((entry) => entry.instrument))
            : Promise.resolve(),
        ]);
      } catch {
        // Best-effort warmup for visible rows only.
      } finally {
        for (const entry of [...quoteEntries, ...forcedSnapshotEntries, ...normalSnapshotEntries]) {
          warmupInFlightRef.current.delete(entry.key);
        }
      }
    };

    const timeoutId = setTimeout(() => {
      if (!cancelled && mountedRef.current) void runBatch();
    }, VISIBLE_FINANCIAL_WARMUP_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [activeSort, appActive, financialsMap, instrumentOptions, liveStreaming, sharedCoordinator, sortedTickers, streamWindow, visibleFinancialTickers, visibleWarmupRequirements]);

  useEffect(() => {
    if (!liveStreaming || !appActive) return;
    if (!sharedCoordinator) return;

    let cancelled = false;
    const runWatchdog = async (): Promise<void> => {
      const nowTimestamp = Date.now();
      const {
        financialsMap: latestFinancialsMap,
        instrumentOptions: latestInstrumentOptions,
        visibleFinancialTickers: latestVisibleFinancialTickers,
      } = watchdogInputsRef.current;
      const quoteEntries = latestVisibleFinancialTickers.flatMap((ticker) => {
        const financials = latestFinancialsMap.get(ticker.metadata.ticker);
        const key = visibleWarmupKey("quote", ticker);
        if (
          !needsVisibleQuoteWatchdogRefresh(financials, nowTimestamp)
          || warmupInFlightRef.current.has(key)
          || nowTimestamp - (warmupAttemptRef.current.get(key) ?? 0) < VISIBLE_QUOTE_REFRESH_COOLDOWN_MS
        ) {
          return [];
        }
        const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, latestInstrumentOptions);
        if (!instrument) return [];
        warmupInFlightRef.current.add(key);
        warmupAttemptRef.current.set(key, nowTimestamp);
        return [{ key, instrument }];
      });
      if (quoteEntries.length === 0) return;

      try {
        await sharedCoordinator.loadQuotesBatch(quoteEntries.map((entry) => entry.instrument), { forceRefresh: true });
      } catch {
        // Best-effort watchdog for visible rows only.
      } finally {
        for (const entry of quoteEntries) {
          warmupInFlightRef.current.delete(entry.key);
        }
      }
    };

    void runWatchdog();
    const intervalId = setInterval(() => {
      if (!cancelled && mountedRef.current) void runWatchdog();
    }, VISIBLE_QUOTE_STREAM_WATCHDOG_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [appActive, liveStreaming, sharedCoordinator]);

  useQuoteUpdates(streamTargets, { liveStreaming });
}
