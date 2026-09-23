import { Box } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { describeFundamentalMarketCap } from "../../../../utils/market-capitalization";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Tabs,
  usePaneFooter,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  type DataTableKeyEvent,
  type TickerListVisibleRange,
} from "../../../../components";
import { useTickerSourceActivate } from "../../shared/ticker-source";
import { useFxRatesMap, useTickerFinancialsMap } from "../../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../../market-data/portfolio-financials";
import { useAppVisible } from "../../../../state/app/activity";
import {
  useAppSelector,
  usePaneCollection,
  usePaneInstance,
  usePaneSettingValue,
  usePaneStateValue,
  type CollectionSortPreference,
  usePaneAppConfig,
} from "../../../../state/app/context";
import { selectEffectiveExchangeRates } from "../../../../utils/exchange-rate-map";
import { summarizeFxRates, fxStatusLabel } from "../../../../utils/fx-status";
import { convertCurrency } from "../../../../utils/format";
import { isPlainKey } from "../../../../utils/keyboard";
import { getSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import type { TickerRecord } from "../../../../types/ticker";
import type { PaneProps } from "../../../../types/plugin";
import type { InstrumentRef } from "../../../../market-data/request-types";
import { calculatePortfolioSummaryTotals, resolveCollectionSortPreference, type ColumnContext } from "../metrics";
import {
  cashMarginDrawerHeight,
  PortfolioCashMarginDrawer,
  shouldToggleCashMarginDrawer,
} from "../header";
import {
  buildPortfolioFooterSegments,
  buildPortfolioSummaryNotices,
  buildPortfolioSummarySegments,
  layoutPortfolioSummaryHeader,
  renderSummarySegments,
} from "../summary";
import { usePortfolioAccountState } from "../summary/live-accounts";
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
import { useCursorNeighborPrefetch } from "../use-cursor-neighbor-prefetch";
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
import { useThrottledMemo } from "../use-throttled-memo";
import { useColumnClock } from "../use-column-clock";
import { liveMarketCapitalization } from "../live-valuation";
import { hasUnknownOptionMultiplier } from "../position-metrics";

// Rows follow every tick. Totals walk the whole collection, so the footer
// coalesces to about four updates a second and the weight denominator to one.
const FOOTER_TOTALS_THROTTLE_MS = 250;
const WEIGHT_TOTAL_THROTTLE_MS = 1_000;
const DAY_MS = 86_400_000;

export function PortfolioListPane({ focused, width, height }: PaneProps) {
  const activateTicker = useTickerSourceActivate();
  const paneInstance = usePaneInstance();
  const appActive = useAppVisible();
  const config = usePaneAppConfig();
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
  const financialsMap = useMemo(
    () => buildPortfolioFinancialsMap(tickers, cachedFinancials, marketFinancialsMap, financialsInstrumentOptions),
    [tickers, cachedFinancials, marketFinancialsMap, financialsInstrumentOptions],
  );
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
  const conversionCurrencies = trackedCurrencies.some((currency) => currency !== config.baseCurrency) ? trackedCurrencies : [];
  const fxStatus = summarizeFxRates(conversionCurrencies, effectiveExchangeRates, (currency) => getSharedMarketDataCoordinator()?.getFxEntry(currency));
  const fxStatusText = fxStatusLabel(fxStatus);
  const activeSort = resolveCollectionSortPreference(activeCollectionId, isPortfolioTab, collectionSorts);
  // Only weights divide by the total: skip the walk when nothing shows one.
  const needsWeightTotal = isPortfolioTab
    && (viewMode === "grid" || columns.some((column) => column.id === "weight"));
  const portfolioTotalMarketValue = useThrottledMemo(
    () => needsWeightTotal ? calculatePortfolioSummaryTotals(
      tickers,
      financialsMap,
      config.baseCurrency,
      effectiveExchangeRates,
      isPortfolioTab,
      activeCollectionId,
    ).totalMktValue : undefined,
    [financialsMap],
    [activeCollectionId, config.baseCurrency, effectiveExchangeRates, isPortfolioTab, needsWeightTotal, tickers],
    WEIGHT_TOTAL_THROTTLE_MS,
  );

  // The header, footer and notices move with live quotes a few times a second,
  // not on every tick.
  const portfolioSummaryTotals = useThrottledMemo(
    () => calculatePortfolioSummaryTotals(
      tickers,
      financialsMap,
      config.baseCurrency,
      effectiveExchangeRates,
      isPortfolioTab,
      activeCollectionId,
    ),
    [financialsMap],
    [activeCollectionId, config.baseCurrency, effectiveExchangeRates, isPortfolioTab, tickers],
    FOOTER_TOTALS_THROTTLE_MS,
  );

  const now = useColumnClock(columns, appActive && viewMode === "table");
  const baseColumnContext = useMemo(() => ({
    activeTab: isPortfolioTab ? activeCollectionId : undefined,
    baseCurrency: config.baseCurrency,
    exchangeRates: effectiveExchangeRates,
    portfolioTotalMarketValue,
    supplementalVersion: supplementalData.version,
    analystResearch: supplementalData.analystResearch,
    corporateActions: supplementalData.corporateActions,
    earningsEvents: supplementalData.earningsEvents,
  }), [
    activeCollectionId,
    config.baseCurrency,
    effectiveExchangeRates,
    isPortfolioTab,
    portfolioTotalMarketValue,
    supplementalData,
  ]);
  const columnContext: ColumnContext = useMemo(() => ({ ...baseColumnContext, now }), [baseColumnContext, now]);
  // The order only follows the per-second clock when sorting by quote age;
  // day-based columns read the day, which the day's start stands for.
  const sortNow = activeSort.columnId === "latency" ? now : Math.floor(now / DAY_MS) * DAY_MS;
  const sortContext: ColumnContext = useMemo(() => ({ ...baseColumnContext, now: sortNow }), [baseColumnContext, sortNow]);

  const candidateSortedTickers = useMemo(
    () => sortTickers(tickers, financialsMap, activeSort, sortContext, columns),
    [tickers, financialsMap, activeSort, sortContext, columns],
  );
  const candidateSymbols = useMemo(
    () => candidateSortedTickers.map((ticker) => ticker.metadata.ticker),
    [candidateSortedTickers],
  );
  const orderResetKey = `${activeCollectionId}|${activeSort.columnId ?? ""}|${activeSort.direction}`;
  const orderedSymbols = useThrottledTickerOrder(candidateSymbols, orderResetKey);
  // Keyed on the records, not the re-sorted candidates, so the rows keep their
  // identity across ticks until the throttled order actually moves.
  const tickerBySymbol = useMemo(
    () => new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker])),
    [tickers],
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

  const prefetchInstrument = useCallback((instrument: InstrumentRef) => {
    getSharedMarketDataCoordinator()?.warmTickerGaps(instrument);
  }, []);
  const noteCursorForPrefetch = useCursorNeighborPrefetch({
    tickers: sortedTickers,
    cursorSymbol,
    portfolioId: financialsInstrumentOptions.portfolioId,
    enabled: appActive,
    prefetch: prefetchInstrument,
  });
  const handleCursorChange = useCallback((ticker: TickerRecord) => {
    noteCursorForPrefetch(ticker.metadata.ticker);
  }, [noteCursorForPrefetch]);

  const showCashDrawer = !paneSettings.hideCash && !!(isPortfolioTab && currentPortfolio?.brokerInstanceId && accountState);
  const summaryAccountState = useMemo(
    () => accountState
      ? { account: accountState.account, sourceLabel: accountState.sourceLabel, snapshotBasis: accountState.snapshotBasis }
      : null,
    [accountState],
  );
  const accountCurrency = accountState?.account.currency ?? "";
  const convertAccountValue = useCallback(
    (value: number) => convertCurrency(value, accountCurrency, config.baseCurrency, effectiveExchangeRates),
    [accountCurrency, config.baseCurrency, effectiveExchangeRates],
  );
  const summarySegments = useMemo(() => buildPortfolioSummarySegments({
    totals: portfolioSummaryTotals,
    accountState: summaryAccountState,
    isPortfolioTab,
    convertAccountValue,
  }), [convertAccountValue, isPortfolioTab, portfolioSummaryTotals, summaryAccountState]);
  // The header row sits in the pane's one-cell side padding, like the table.
  const summaryWidth = Math.max(0, width - 2);
  const summaryLayout = useMemo(() => layoutPortfolioSummaryHeader(summarySegments, summaryWidth, {
    cashDrawer: showCashDrawer,
    hideHeader: paneSettings.hideHeader,
  }), [paneSettings.hideHeader, showCashDrawer, summarySegments, summaryWidth]);
  const showCollectionTabs = visibleCollections.length > 1;
  const handleCollectionSelect = useCallback((collectionId: string) => {
    cancelPendingCursorSymbol();
    setCurrentCollectionId(collectionId);
  }, [cancelPendingCursorSymbol, setCurrentCollectionId]);
  const collectionTabs = useMemo(
    () => visibleCollections.map((collection) => ({ label: collection.name, value: collection.id })),
    [visibleCollections],
  );
  const tabsInHeader = usePaneHeaderTabs(showCollectionTabs
    ? {
      tabs: collectionTabs,
      activeValue: activeCollectionId,
      onSelect: handleCollectionSelect,
      focused: focused && !quickAddFocused,
    }
    : null);
  const headerHeight = showCollectionTabs && !tabsInHeader ? 1 : 0;
  const summaryHeight = summaryLayout.row.length > 0 && height > headerHeight + 2 ? 1 : 0;
  const drawerHeight = showCashDrawer && cashDrawerExpanded
    ? Math.min(cashMarginDrawerHeight(accountState, summaryLayout.detail.length), Math.max(1, height - (headerHeight + summaryHeight + 2)))
    : 0;

  const handleVisibleRangeChange = useCallback(({ start, end }: TickerListVisibleRange) => {
    setStreamWindow((current) => (
      current.start === start && current.end === end ? current : { start, end }
    ));
  }, []);

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

    if (shouldToggleCashMarginDrawer(event, showCashDrawer)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setCashDrawerExpanded(!cashDrawerExpanded);
      return true;
    }

    if (isPlainKey(event, "s") && isPortfolioTab) {
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

  const summaryFooterInfo = useThrottledMemo(() => buildPortfolioFooterSegments({
    accountState: summaryAccountState,
    accountStatusText: accountsError
      ? `Accounts unavailable: ${accountsError}`
      : isPortfolioTab && currentPortfolio?.brokerInstanceId && !accountState ? "Acct missing" : undefined,
    financialsMap,
    isPortfolioTab,
    refreshingSize,
    sortedTickers,
    totals: portfolioSummaryTotals,
  }), [financialsMap, sortedTickers], [
    accountState,
    accountsError,
    currentPortfolio?.brokerInstanceId,
    isPortfolioTab,
    portfolioSummaryTotals,
    refreshingSize,
    summaryAccountState,
  ], FOOTER_TOTALS_THROTTLE_MS);
  const fxWarning = !!(fxStatus.stale || fxStatus.unknownTime || fxStatus.unavailable);
  const summaryNotices = isPortfolioTab
    ? buildPortfolioSummaryNotices({
      totals: portfolioSummaryTotals,
      accountState: summaryAccountState,
      baseCurrency: config.baseCurrency,
      convertAccountValue,
      fxStatus: fxWarning ? fxStatus : undefined,
    })
    : fxWarning ? [`FX ${fxStatusText}`] : [];

  usePaneFooter("portfolio-list", () => ({
    info: fxStatusText && !fxWarning
      ? [...summaryFooterInfo, { id: "fx", parts: [{ text: `FX ${fxStatusText}`, tone: "muted" as const }] }]
      : summaryFooterInfo,
    hints: showCashDrawer
      ? [{
          id: "cash",
          key: "c",
          label: "ash",
          onPress: () => setCashDrawerExpanded(!cashDrawerExpanded),
        }]
      : [],
  }), [cashDrawerExpanded, fxStatusText, fxWarning, setCashDrawerExpanded, showCashDrawer, summaryFooterInfo]);

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
  const selectedFinancials = cursorSymbol ? financialsMap.get(cursorSymbol) : undefined;
  const selectedCap = liveMarketCapitalization(selectedFinancials?.quote, selectedFinancials?.fundamentals);
  // A cap repriced from the live price has no stale valuation date to explain.
  const capNotice = viewMode === "table" && columns.some((column) => column.id === "market_cap")
    && selectedCap?.provenance.kind === "fundamentals" && !selectedCap.live
    ? `${cursorSymbol} market cap: ${describeFundamentalMarketCap(selectedCap.provenance)}.` : undefined;
  const selectedTicker = cursorSymbol ? tickerBySymbol.get(cursorSymbol) : undefined;
  const multiplierNotice = isPortfolioTab && selectedTicker && hasUnknownOptionMultiplier(selectedTicker, activeCollectionId)
    ? `${cursorSymbol} has no contract multiplier; its value assumes 1x.` : undefined;
  usePaneNoticeFooter({
    registrationId: "portfolio-list-notices",
    notices: [...summaryNotices, capNotice, multiplierNotice].filter((notice): notice is string => !!notice),
    focused: focused && !quickAddFocused,
  });
  const contentHeight = Math.max(1, height - headerHeight - summaryHeight - drawerHeight - quickAddHeight);
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
      {showCollectionTabs && !tabsInHeader && (
        <Box flexDirection="column" height={headerHeight}>
          <Box flexDirection="row" height={1}>
            <Box flexShrink={1} overflow="hidden">
              <Tabs
                tabs={collectionTabs}
                activeValue={activeCollectionId}
                onSelect={handleCollectionSelect}
                compact
                focused={focused && !quickAddFocused}
              />
            </Box>
          </Box>
        </Box>
      )}

      {summaryHeight > 0 && (
        <Box height={1} paddingX={1} overflow="hidden">
          {renderSummarySegments(summaryLayout.row, summaryWidth)}
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
          onCursorChange={handleCursorChange}
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

      {drawerHeight > 0 && accountState && (
        <Box height={drawerHeight} paddingX={1}>
          <PortfolioCashMarginDrawer
            accountState={accountState}
            detail={summaryLayout.detail}
            onToggle={() => setCashDrawerExpanded(false)}
            width={summaryWidth}
            height={drawerHeight}
          />
        </Box>
      )}

    </Box>
  );
}
