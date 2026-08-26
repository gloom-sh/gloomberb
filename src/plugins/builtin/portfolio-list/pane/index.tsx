import { Box } from "../../../../ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tabs,
  usePaneFooter,
  type DataTableKeyEvent,
  type TickerListVisibleRange,
} from "../../../../components";
import { useTickerSourceActivate } from "../../shared/ticker-source";
import { useFxRatesMap, useTickerFinancialsMap } from "../../../../market-data/hooks";
import { useAppActive } from "../../../../state/app/activity";
import {
  useAppSelector,
  usePaneCollection,
  usePaneInstance,
  usePaneSettingValue,
  usePaneStateValue,
  type CollectionSortPreference,
} from "../../../../state/app/context";
import { selectEffectiveExchangeRates } from "../../../../utils/exchange-rate-map";
import type { TickerRecord } from "../../../../types/ticker";
import type { PaneProps } from "../../../../types/plugin";
import { calculatePortfolioSummaryTotals, resolveCollectionSortPreference, type ColumnContext } from "../metrics";
import {
  PortfolioCashMarginDrawer,
  shouldToggleCashMarginDrawer,
  usePortfolioAccountState,
} from "../header";
import { buildPortfolioFooterSegments } from "../summary";
import {
  getCollectionEntries,
  getPortfolioPaneSettings,
  resolveActiveCollectionId,
  resolveScopedCollectionEntries,
  resolveVisibleColumns,
  type PortfolioViewMode,
} from "../settings";
import { useQuoteFlashMap } from "../../../../components/quote-flash";
import { PortfolioTickerTable } from "../table";
import { PortfolioGrid } from "../grid";
import { useThrottledCursorSymbol } from "../use-throttled-cursor-symbol";
import { isManualPortfolio } from "../mutations";
import { QuickAddTickerInput, type QuickAddCollectionKind } from "../quick-add";
import {
  buildTrackedCurrencies,
  getCollectionTickersFromConfig,
  getCollectionTypeFromConfig,
  resolveVisibleWarmupRequirements,
  sortTickers,
} from "./data";
import { usePortfolioPaneStreaming } from "./streaming";
import { usePortfolioSupplementalData } from "./supplemental";
import { useLiveStreamingSetting } from "../../shared/live-streaming";
import { useThrottledTickerOrder } from "../use-throttled-ticker-order";

export function PortfolioListPane({ focused, width, height }: PaneProps) {
  const activateTicker = useTickerSourceActivate();
  const paneInstance = usePaneInstance();
  const appActive = useAppActive();
  const config = useAppSelector((state) => state.config);
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedFinancials = useAppSelector((state) => state.financials);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const refreshingSize = useAppSelector((state) => state.refreshing.size);
  const paneCollection = usePaneCollection();
  const liveStreaming = useLiveStreamingSetting();

  const [currentCollectionId, setCurrentCollectionId] = usePaneStateValue<string>("collectionId", paneCollection.collectionId ?? "");
  const [committedCursorSymbol, setCommittedCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);
  const [collectionSorts, setCollectionSorts] = usePaneStateValue<Record<string, CollectionSortPreference>>("collectionSorts", {});
  const [cashDrawerExpanded, setCashDrawerExpanded] = usePaneStateValue<boolean>("cashDrawerExpanded", false);
  const [, setViewMode] = usePaneSettingValue<PortfolioViewMode>("viewMode", "table");

  const [now, setNow] = useState(Date.now());
  const [streamWindow, setStreamWindow] = useState({ start: 0, end: 24 });
  const [quickAddFocused, setQuickAddFocused] = useState(false);

  const {
    cursorSymbol,
    setCursorSymbol,
    flushCursorSymbol,
    cancelPendingCursorSymbol,
  } = useThrottledCursorSymbol(committedCursorSymbol, setCommittedCursorSymbol);

  const paneSettings = useMemo(
    () => getPortfolioPaneSettings(paneInstance?.settings),
    [paneInstance?.settings],
  );
  const collectionEntries = useMemo(
    () => getCollectionEntries(config),
    [config],
  );
  const visibleCollections = useMemo(
    () => resolveScopedCollectionEntries(collectionEntries, paneSettings),
    [collectionEntries, paneSettings],
  );
  const activeCollectionId = resolveActiveCollectionId(currentCollectionId, visibleCollections);
  const isPortfolioTab = getCollectionTypeFromConfig(config, activeCollectionId) === "portfolio";
  const activeCollectionEntry = visibleCollections.find((collection) => collection.id === activeCollectionId) ?? null;
  const currentPortfolio = useMemo(() => (
    isPortfolioTab
      ? config.portfolios.find((portfolio) => portfolio.id === activeCollectionId) ?? null
      : null
  ), [activeCollectionId, config.portfolios, isPortfolioTab]);
  const viewMode: PortfolioViewMode = isPortfolioTab ? paneSettings.viewMode : "table";

  const tickers = useMemo(
    () => getCollectionTickersFromConfig(config, tickersBySymbol, activeCollectionId),
    [activeCollectionId, config, tickersBySymbol],
  );
  const financialsInstrumentOptions = useMemo(() => ({
    portfolioId: isPortfolioTab ? activeCollectionId : undefined,
  }), [activeCollectionId, isPortfolioTab]);
  const marketFinancialsMap = useTickerFinancialsMap(tickers, financialsInstrumentOptions);
  const financialsMap = useMemo(() => {
    const merged = new Map(cachedFinancials);
    for (const [symbol, financials] of marketFinancialsMap) {
      merged.set(symbol, financials);
    }
    return merged;
  }, [cachedFinancials, marketFinancialsMap]);
  const valueFlashingEnabled = useAppSelector((state) => state.config.valueFlashingEnabled);
  const flashSymbols = useQuoteFlashMap(financialsMap, valueFlashingEnabled);

  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState, accountsError } = usePortfolioAccountState(currentPortfolio, accountStateInput);
  const columns = useMemo(
    () => resolveVisibleColumns(paneSettings.columnIds, isPortfolioTab),
    [isPortfolioTab, paneSettings.columnIds],
  );
  const supplementalData = usePortfolioSupplementalData(tickers, columns, appActive);
  const visibleWarmupRequirements = useMemo(
    () => resolveVisibleWarmupRequirements(columns),
    [columns],
  );

  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(tickers, financialsMap, accountState, config.baseCurrency),
    [accountState, config.baseCurrency, financialsMap, tickers],
  );
  const fetchedExchangeRates = useFxRatesMap(trackedCurrencies);
  const effectiveExchangeRates = selectEffectiveExchangeRates(fetchedExchangeRates, cachedExchangeRates);
  const portfolioSummaryTotals = useMemo(() => calculatePortfolioSummaryTotals(
    tickers,
    financialsMap,
    config.baseCurrency,
    effectiveExchangeRates,
    isPortfolioTab,
    activeCollectionId,
  ), [activeCollectionId, config.baseCurrency, effectiveExchangeRates, financialsMap, isPortfolioTab, tickers]);

  const columnContext: ColumnContext = useMemo(() => ({
    activeTab: isPortfolioTab ? activeCollectionId : undefined,
    baseCurrency: config.baseCurrency,
    exchangeRates: effectiveExchangeRates,
    now,
    portfolioTotalMarketValue: portfolioSummaryTotals.totalMktValue,
    supplementalVersion: supplementalData.version,
    analystResearch: supplementalData.analystResearch,
    corporateActions: supplementalData.corporateActions,
    earningsEvents: supplementalData.earningsEvents,
  }), [
    activeCollectionId,
    config.baseCurrency,
    effectiveExchangeRates,
    isPortfolioTab,
    now,
    portfolioSummaryTotals.totalMktValue,
    supplementalData,
  ]);

  const activeSort = resolveCollectionSortPreference(activeCollectionId, isPortfolioTab, collectionSorts);
  const candidateSortedTickers = useMemo(
    () => sortTickers(tickers, financialsMap, activeSort, columnContext, columns),
    [tickers, financialsMap, activeSort, columnContext, columns],
  );
  const candidateSymbols = useMemo(
    () => candidateSortedTickers.map((ticker) => ticker.metadata.ticker),
    [candidateSortedTickers],
  );
  const orderResetKey = `${activeCollectionId}|${activeSort.columnId ?? ""}|${activeSort.direction}`;
  const orderedSymbols = useThrottledTickerOrder(candidateSymbols, orderResetKey);
  const tickerBySymbol = useMemo(
    () => new Map(candidateSortedTickers.map((ticker) => [ticker.metadata.ticker, ticker])),
    [candidateSortedTickers],
  );
  const sortedTickers = useMemo(
    () => orderedSymbols.flatMap((symbol) => {
      const ticker = tickerBySymbol.get(symbol);
      return ticker ? [ticker] : [];
    }),
    [orderedSymbols, tickerBySymbol],
  );

  const selectedIdx = sortedTickers.findIndex((ticker) => ticker.metadata.ticker === cursorSymbol);
  const safeSelectedIdx = selectedIdx >= 0 ? selectedIdx : 0;

  const showCashDrawer = !paneSettings.hideCash && !!(isPortfolioTab && currentPortfolio?.brokerInstanceId && accountState);
  const requestedDrawerHeight = showCashDrawer
    ? (cashDrawerExpanded ? Math.min(6, Math.max(3, 2 + accountState.visibleCashBalances.length)) : 1)
    : 0;
  const showCollectionTabs = visibleCollections.length > 1;
  const headerHeight = showCollectionTabs ? 1 : 0;
  const drawerHeight = showCashDrawer
    ? Math.min(requestedDrawerHeight, Math.max(1, height - (headerHeight + 2)))
    : 0;

  const handleVisibleRangeChange = useCallback(({ start, end }: TickerListVisibleRange) => {
    setStreamWindow((current) => (
      current.start === start && current.end === end ? current : { start, end }
    ));
  }, []);

  const handleCollectionSelect = useCallback((collectionId: string) => {
    cancelPendingCursorSymbol();
    setCurrentCollectionId(collectionId);
  }, [cancelPendingCursorSymbol, setCurrentCollectionId]);

  const setSortPreference = useCallback((preference: CollectionSortPreference) => {
    if (!activeCollectionId) return;
    setCollectionSorts({
      ...collectionSorts,
      [activeCollectionId]: preference,
    });
  }, [activeCollectionId, collectionSorts, setCollectionSorts]);

  const handleHeaderClick = useCallback((columnId: string) => {
    if (activeSort.columnId === columnId) {
      setSortPreference(
        activeSort.direction === "asc"
          ? { columnId, direction: "desc" }
          : { columnId: null, direction: "asc" },
      );
      return;
    }
    setSortPreference({ columnId, direction: "asc" });
  }, [activeSort.columnId, activeSort.direction, setSortPreference]);

  const openTickerFloating = useCallback((symbol: string, options?: { newPane?: boolean }) => {
    activateTicker(symbol, { floating: true, newPane: options?.newPane });
  }, [activateTicker]);

  const toggleViewMode = useCallback(() => {
    if (!isPortfolioTab) return;
    setViewMode((current) => current === "table" ? "grid" : "table");
  }, [isPortfolioTab, setViewMode]);

  const handleRowActivate = useCallback((ticker: TickerRecord) => {
    flushCursorSymbol(ticker.metadata.ticker);
    openTickerFloating(ticker.metadata.ticker);
  }, [flushCursorSymbol, openTickerFloating]);
  const handleTickerAdded = useCallback((symbol: string) => {
    setCursorSymbol(symbol, { immediate: true });
  }, [setCursorSymbol]);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!focused) return;

    const key = event.name;
    const isEnter = key === "enter" || key === "return";

    if (isEnter && event.shift) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const ticker = sortedTickers[safeSelectedIdx];
      if (ticker) {
        flushCursorSymbol(ticker.metadata.ticker);
        openTickerFloating(ticker.metadata.ticker, { newPane: true });
      }
      return true;
    }

    if (shouldToggleCashMarginDrawer(key, showCashDrawer)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setCashDrawerExpanded(!cashDrawerExpanded);
      return true;
    }

    if (key === "s" && isPortfolioTab) {
      event.preventDefault?.();
      event.stopPropagation?.();
      toggleViewMode();
      return true;
    }

    return false;
  }, [
    cashDrawerExpanded,
    flushCursorSymbol,
    focused,
    isPortfolioTab,
    openTickerFloating,
    safeSelectedIdx,
    setCashDrawerExpanded,
    showCashDrawer,
    sortedTickers,
    toggleViewMode,
  ]);

  useEffect(() => {
    if (activeCollectionId !== currentCollectionId) {
      cancelPendingCursorSymbol();
      setCurrentCollectionId(activeCollectionId);
    }
  }, [activeCollectionId, cancelPendingCursorSymbol, currentCollectionId, setCurrentCollectionId]);

  useEffect(() => {
    if (!appActive) return;
    // Only ages relative labels (quote age, days held), so the shared 30s cadence is enough.
    const timerId = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timerId);
  }, [appActive]);

  useEffect(() => {
    if (sortedTickers.length === 0) {
      if (cursorSymbol !== null) setCursorSymbol(null, { immediate: true });
      return;
    }

    const hasSelection = cursorSymbol && sortedTickers.some((ticker) => ticker.metadata.ticker === cursorSymbol);
    if (!hasSelection) {
      setCursorSymbol(sortedTickers[0]!.metadata.ticker, { immediate: true });
    }
  }, [cursorSymbol, setCursorSymbol, sortedTickers]);

  const effectiveStreamWindow = useMemo(() => (
    viewMode === "grid"
      ? { start: 0, end: Math.min(sortedTickers.length, 96) }
      : {
        start: streamWindow.start,
        end: Math.min(sortedTickers.length, Math.max(streamWindow.end, height + 4)),
      }
  ), [height, sortedTickers.length, streamWindow, viewMode]);

  usePortfolioPaneStreaming({
    appActive,
    activeCollectionId: isPortfolioTab ? activeCollectionId : undefined,
    sortedTickers,
    cursorSymbol,
    streamWindow: effectiveStreamWindow,
    isPortfolioTab,
    activeSort,
    financialsMap,
    visibleWarmupRequirements,
    liveStreaming,
  });

  const summaryFooterInfo = useMemo(() => buildPortfolioFooterSegments({
    accountState: accountState ? { account: accountState.account, sourceLabel: accountState.sourceLabel } : null,
    accountStatusText: accountsError
      ? `Accounts unavailable: ${accountsError}`
      : isPortfolioTab && currentPortfolio?.brokerInstanceId && !accountState ? "Acct missing" : undefined,
    activeCollectionId,
    baseCurrency: config.baseCurrency,
    exchangeRates: effectiveExchangeRates,
    financialsMap,
    hideHeader: paneSettings.hideHeader,
    isPortfolioTab,
    refreshingSize,
    sortedTickers,
    width,
  }), [
    accountState,
    accountsError,
    activeCollectionId,
    currentPortfolio?.brokerInstanceId,
    effectiveExchangeRates,
    financialsMap,
    isPortfolioTab,
    paneSettings.hideHeader,
    config.baseCurrency,
    refreshingSize,
    sortedTickers,
    width,
  ]);

  usePaneFooter("portfolio-list", () => ({
    info: summaryFooterInfo,
    hints: showCashDrawer
      ? [{
          id: "cash",
          key: "c",
          label: "ash",
          onPress: () => setCashDrawerExpanded(!cashDrawerExpanded),
        }]
      : [],
  }), [cashDrawerExpanded, setCashDrawerExpanded, showCashDrawer, summaryFooterInfo]);

  const quickAddCollectionKind = useMemo<QuickAddCollectionKind | null>(() => {
    if (!activeCollectionId) return null;
    const collectionType = getCollectionTypeFromConfig(config, activeCollectionId);
    if (collectionType === "watchlist") return "watchlist";
    if (collectionType === "portfolio" && currentPortfolio && isManualPortfolio(currentPortfolio)) {
      return "portfolio";
    }
    return null;
  }, [activeCollectionId, config, currentPortfolio]);
  const showQuickAdd = !!(activeCollectionId && activeCollectionEntry && quickAddCollectionKind);
  const quickAddHeight = showQuickAdd ? 1 : 0;
  const contentHeight = Math.max(1, height - headerHeight - drawerHeight - quickAddHeight);
  const quickAddRow = activeCollectionId && activeCollectionEntry && quickAddCollectionKind ? (
    <QuickAddTickerInput
      collectionId={activeCollectionId}
      collectionKind={quickAddCollectionKind}
      collectionName={activeCollectionEntry.name}
      focused={focused}
      width={width}
      onAdded={handleTickerAdded}
      onFocusChange={setQuickAddFocused}
    />
  ) : null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {showCollectionTabs && (
        <Box flexDirection="column" height={headerHeight}>
          <Box flexDirection="row" height={1}>
            <Box flexShrink={1} overflow="hidden">
              <Tabs
                tabs={visibleCollections.map((collection) => ({ label: collection.name, value: collection.id }))}
                activeValue={activeCollectionId}
                onSelect={handleCollectionSelect}
                compact
                focused={focused && !quickAddFocused}
              />
            </Box>
          </Box>
        </Box>
      )}

      {viewMode === "table" ? (
        <PortfolioTickerTable
          columns={columns}
          focused={focused && !quickAddFocused}
          sortColumnId={activeSort.columnId}
          sortDirection={activeSort.direction}
          onHeaderClick={handleHeaderClick}
          sortedTickers={sortedTickers}
          cursorSymbol={cursorSymbol}
          setCursorSymbol={setCursorSymbol}
          financialsMap={financialsMap}
          columnContext={columnContext}
          flashSymbols={flashSymbols}
          onRootKeyDown={handleTableKeyDown}
          onVisibleRangeChange={handleVisibleRangeChange}
          visibleRangeBuffer={3}
          resetScrollKey={activeCollectionId}
          onRowActivate={handleRowActivate}
          rootHeight={contentHeight}
        />
      ) : (
        <PortfolioGrid
          sortedTickers={sortedTickers}
          financialsMap={financialsMap}
          columnContext={columnContext}
          isPortfolioTab={isPortfolioTab}
          cursorSymbol={cursorSymbol}
          setCursorSymbol={(symbol) => setCursorSymbol(symbol)}
          onRowActivate={handleRowActivate}
          onToggleViewMode={toggleViewMode}
          focused={focused && !quickAddFocused}
          width={width}
          height={contentHeight}
        />
      )}

      {quickAddRow}

      {showCashDrawer && accountState && (
        <Box height={drawerHeight} paddingX={1}>
          <PortfolioCashMarginDrawer
            accountState={accountState}
            expanded={cashDrawerExpanded}
            onToggle={() => setCashDrawerExpanded(!cashDrawerExpanded)}
            width={Math.max(0, width - 2)}
            height={drawerHeight}
          />
        </Box>
      )}
    </Box>
  );
}
