import { useEffect, useMemo } from "react";
import type { QuoteSubscriptionTarget } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";
import { useAppSelector } from "../../../../state/app/context";
import { useFxRatesMap, useTickerFinancialsMap } from "../../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import { instrumentFromTicker, quoteSubscriptionTargetFromTicker } from "../../../../market-data/request-types";
import { useQuoteUpdates } from "../../../../state/hooks/quote-streaming";
import type { ColumnContext } from "../../portfolio-list/metrics";
import type { ColumnConfig } from "../../../../types/config";
import type { ValidatedScreenerResult } from "./contract";
import { EMPTY_SORT, type AiScreenerTab, type ScreenerSortPreference } from "./model";
import { sortScreenerRows } from "./results";

interface UseAiScreenerMarketRuntimeOptions {
  activeSort: ScreenerSortPreference;
  activeTab: AiScreenerTab | null;
  columns: ColumnConfig[];
  cursorSymbol: string | null;
  now: number;
  resultMap: Map<string, ValidatedScreenerResult>;
  setCursorSymbol: (symbol: string | null) => void;
  tickers: Map<string, TickerRecord>;
  liveStreaming: boolean;
}

export function useAiScreenerMarketRuntime({
  activeSort,
  activeTab,
  columns,
  cursorSymbol,
  now,
  resultMap,
  setCursorSymbol,
  tickers,
  liveStreaming,
}: UseAiScreenerMarketRuntimeOptions) {
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const screenerTickers = useMemo(() => (
    (activeTab?.results ?? [])
      .map((result) => tickers.get(result.symbol) ?? null)
      .filter((ticker): ticker is TickerRecord => ticker != null)
  ), [activeTab?.results, tickers]);
  const financialsMap = useTickerFinancialsMap(screenerTickers);

  const trackedCurrencies = useMemo(() => [
    baseCurrency,
    ...screenerTickers.map((ticker) => ticker.metadata.currency),
    ...screenerTickers.map((ticker) => financialsMap.get(ticker.metadata.ticker)?.quote?.currency ?? null),
  ], [baseCurrency, financialsMap, screenerTickers]);
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  const effectiveExchangeRates = exchangeRates.size > 1 || cachedExchangeRates.size === 0
    ? exchangeRates
    : cachedExchangeRates;
  const columnContext: ColumnContext = useMemo(() => ({
    baseCurrency,
    exchangeRates: effectiveExchangeRates,
    now,
  }), [baseCurrency, effectiveExchangeRates, now]);

  const sortedTickers = useMemo(
    () => sortScreenerRows(screenerTickers, resultMap, financialsMap, activeSort ?? EMPTY_SORT, columnContext, columns),
    [activeSort, columnContext, columns, financialsMap, resultMap, screenerTickers],
  );
  const quoteTargets = useMemo<QuoteSubscriptionTarget[]>(() => (
    sortedTickers.flatMap((ticker) => {
      const target = quoteSubscriptionTargetFromTicker(ticker, ticker.metadata.ticker);
      return target ? [{ ...target, surface: "screener", visible: true, weight: 70 }] : [];
    })
  ), [sortedTickers]);

  useQuoteUpdates(quoteTargets, { liveStreaming });

  useEffect(() => {
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    for (const ticker of sortedTickers) {
      const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker);
      if (instrument) {
        void coordinator.loadSnapshot(instrument).catch(() => {});
      }
    }
  }, [sortedTickers]);

  useEffect(() => {
    if (sortedTickers.length === 0) {
      if (cursorSymbol !== null) setCursorSymbol(null);
      return;
    }
    if (!cursorSymbol || !sortedTickers.some((ticker) => ticker.metadata.ticker === cursorSymbol)) {
      setCursorSymbol(sortedTickers[0]!.metadata.ticker);
    }
  }, [cursorSymbol, setCursorSymbol, sortedTickers]);

  return {
    columnContext,
    financialsMap,
    sortedTickers,
  };
}
