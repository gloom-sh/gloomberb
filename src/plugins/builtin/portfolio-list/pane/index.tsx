import { Box } from "../../../../ui";
import { describeFundamentalMarketCap } from "../../../../utils/market-capitalization";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmDialog,
  usePaneFooter,
  usePaneMenuItems,
  usePaneNoticeFooter,
  usePaneTabs,
  type DataTableKeyEvent,
  type TickerListVisibleRange,
} from "../../../../components";
import { useTickerSourceActivate } from "../../../../react/ticker-source";
import { useFxRatesMap, useTickerFinancialsMap } from "../../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../../market-data/portfolio-financials";
import { useAppActive, useAppVisible, usePaneVisible } from "../../../../state/app/activity";
import { tf } from "../../../../i18n";
import { useDialog } from "../../../../ui/dialog";
import {
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
  usePaneCollection,
  usePaneInstance,
  usePaneSettingValue,
  usePaneStateValue,
  type CollectionSortPreference,
  usePaneAppConfig,
} from "../../../../state/app/context";
import { summarizeFxRates, fxStatusLabel } from "../../../../utils/fx-status";
import { convertCurrency } from "../../../../utils/format";
import { nextHeaderSort } from "../../../../utils/sort-values";
import { getSharedMarketDataCoordinator } from "../../../../market-data/coordinator";
import type { TickerRecord } from "../../../../types/ticker";
import type { PaneProps } from "../../../../types/plugin";
import type { InstrumentRef } from "../../../../market-data/request-types";
import {
  calculatePortfolioSummaryTotals,
  getSortValue,
  resolveCollectionSortPreference,
  resolvePortfolioTotalsCurrency,
  type ColumnContext,
} from "../metrics";
import {
  cashMarginDrawerHeight,
  PortfolioCashMarginDrawer,
} from "../header";
import {
  buildPortfolioFooterSegments,
  buildPortfolioSummaryNotices,
  buildPortfolioSummarySegments,
  layoutPortfolioSummaryHeader,
  renderSummarySegments,
} from "../summary";
import { usePortfolioAccountState } from "../summary/live-accounts";
import { useOfflineBrokerFooter } from "../../shared/broker-reconnect";
import {
  getCollectionEntries,
  getPortfolioPaneSettings,
  resolveActiveCollectionId,
  resolveScopedCollectionEntries,
  resolveVisibleColumns,
  type PortfolioViewMode,
} from "../settings";
import { useQuoteFlashMap } from "../../../../components/quote-flash";
import { sinceLastSeenAfterMs, useSinceLastSeen } from "../since-last-seen";
import { PortfolioTickerTable } from "../table";
import { PortfolioGrid } from "../grid";
import { useThrottledCursorSymbol } from "../use-throttled-cursor-symbol";
import { useCursorNeighborPrefetch } from "../use-cursor-neighbor-prefetch";
import { getSharedRegistry } from "../../../registry";
import { usePluginAppActions } from "../../../runtime";
import { isManualPortfolio } from "../../../../portfolio/mutations";
import {
  cursorAfterRemoval,
  removableCollection,
  removeTickerFromCollection,
  tickerRemovalSummary,
} from "./remove-ticker";
import { QuickAddTickerInput, type QuickAddCollectionKind } from "../quick-add";
import { delistingLabel } from "../../../../market-data/quotes/delisting";
import {
  buildTrackedCurrencies,
  holdsOtherCurrencies,
  getCollectionTickersFromConfig,
  getCollectionTypeFromConfig,
  resolveVisibleWarmupRequirements,
  sortTickers,
} from "./data";
import { usePortfolioPaneStreaming } from "./streaming";
import { usePortfolioSupplementalData } from "./supplemental";
import { PERPETUAL_COLUMN_IDS } from "../cell-version";
import { useListPerpetuals } from "../../perps/list-perpetuals";
import { openPerpLabel, useOpenPerpMarket } from "../../perps/open-market";
import { useLiveStreamingSetting } from "../../../../state/hooks/live-streaming";
import { useThrottledTickerOrder } from "../use-throttled-ticker-order";
import { useThrottledMemo } from "../use-throttled-memo";
import { perpetualDisplaySymbol, perpetualListing, perpetualVenueName } from "../../../../tickers/perpetual-listing";
import { useColumnClock } from "../use-column-clock";
import { liveMarketCapitalization } from "../../../../market-data/quotes/live-valuation";
import { hasUnknownOptionMultiplier } from "../../../../portfolio/position-metrics";
import { withFuturesContractSizes } from "../../../../portfolio/futures-positions";
import { usePortfolioFuturesTerms } from "./futures-terms";
import {
  allocationWeightBase,
  buildPortfolioAllocation,
  CASH_SYMBOL,
  hasTargetWeights,
  resolvePortfolioCash,
} from "../../../../portfolio/allocation";

/** Columns that need the portfolio's total. */
const ALLOCATION_COLUMN_IDS = new Set(["weight", "drift", "trade", "trade_value"]);

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
  // Bumped by the empty table's "+ ticker" button to open the add row.
  const [quickAddRequest, setQuickAddRequest] = useState(0);

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
  const valuationBasis = paneSettings.valueAtClose ? "regular-close" as const : "latest-print" as const;

  const collectionTickers = useMemo(
    () => getCollectionTickersFromConfig(config, tickersBySymbol, activeCollectionId),
    [activeCollectionId, config, tickersBySymbol],
  );
  // A future counts contracts of the size its terms give, and at the close is valued at its settlement.
  const futuresTerms = usePortfolioFuturesTerms(collectionTickers, { enabled: isPortfolioTab, settlement: valuationBasis === "regular-close" });
  const tickers = useMemo(
    () => withFuturesContractSizes(collectionTickers, futuresTerms.terms),
    [collectionTickers, futuresTerms.terms],
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
  const { accountState, accountsError, offline } = usePortfolioAccountState(currentPortfolio, accountStateInput);
  const brokerPortfolio = isPortfolioTab && !!currentPortfolio?.brokerInstanceId;
  // The positions stay as last synced while the broker is away, dated, with one key to bring it back.
  const offlineBrokerFooter = useOfflineBrokerFooter(brokerPortfolio ? offline : null);
  const portfolioTargets = currentPortfolio?.targetWeights;
  // Totals, money columns and account values are in the portfolio's currency.
  const totalsCurrency = useMemo(
    () => resolvePortfolioTotalsCurrency(currentPortfolio, config.baseCurrency),
    [config.baseCurrency, currentPortfolio],
  );
  // A boolean, so a quote tick does not rebuild the columns.
  const otherCurrencies = holdsOtherCurrencies(tickers, financialsMap, totalsCurrency);
  const columns = useMemo(
    () => resolveVisibleColumns(paneSettings.columnIds, isPortfolioTab, { targetWeights: hasTargetWeights(currentPortfolio), otherCurrencies }),
    [currentPortfolio, isPortfolioTab, otherCurrencies, paneSettings.columnIds],
  );
  const supplementalData = usePortfolioSupplementalData(tickers, columns, appActive, financialsMap);
  // One lookup for the whole list, only while a perpetual column is on screen.
  const showsPerpetuals = viewMode === "table" && columns.some((column) => PERPETUAL_COLUMN_IDS.has(column.id));
  const perpetuals = useListPerpetuals(tickers, showsPerpetuals);
  const openPerpMarket = useOpenPerpMarket();
  const visibleWarmupRequirements = useMemo(
    () => resolveVisibleWarmupRequirements(columns),
    [columns],
  );

  // The broker account's cash when it reports one, else the cash entered by hand.
  const cashLine = useMemo(
    () => isPortfolioTab ? resolvePortfolioCash(currentPortfolio, accountState?.account) : null,
    [accountState, currentPortfolio, isPortfolioTab],
  );
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(tickers, financialsMap, accountState, totalsCurrency, cashLine?.source === "manual" ? cashLine.currency : undefined),
    [accountState, cashLine, financialsMap, tickers, totalsCurrency],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  const conversionCurrencies = trackedCurrencies.some((currency) => currency !== totalsCurrency) ? trackedCurrencies : [];
  const fxStatus = summarizeFxRates(conversionCurrencies, exchangeRates, (currency) => getSharedMarketDataCoordinator()?.getFxEntry(currency));
  const fxStatusText = fxStatusLabel(fxStatus);
  const activeSort = resolveCollectionSortPreference(activeCollectionId, isPortfolioTab, collectionSorts);
  const accountCurrency = accountState?.account.currency ?? "";
  const convertAccountValue = useCallback(
    (value: number) => convertCurrency(value, accountCurrency, totalsCurrency, exchangeRates),
    [accountCurrency, exchangeRates, totalsCurrency],
  );
  const cashValue = cashLine == null ? null
    : cashLine.source === "broker" ? convertAccountValue(cashLine.amount)
      : convertCurrency(cashLine.amount, cashLine.currency, totalsCurrency, exchangeRates);
  // Only weights divide by the total: skip the walk when nothing shows one.
  const needsWeightTotal = isPortfolioTab
    && (viewMode === "grid" || columns.some((column) => ALLOCATION_COLUMN_IDS.has(column.id)));
  const weightHoldings = useThrottledMemo(
    () => needsWeightTotal ? calculatePortfolioSummaryTotals(
      tickers,
      financialsMap,
      totalsCurrency,
      exchangeRates,
      isPortfolioTab,
      activeCollectionId,
      valuationBasis,
      futuresTerms.terms,
    ).allocationHoldings : undefined,
    [financialsMap],
    [activeCollectionId, exchangeRates, futuresTerms.terms, isPortfolioTab, needsWeightTotal, tickers, totalsCurrency, valuationBasis],
    WEIGHT_TOTAL_THROTTLE_MS,
  );
  // Priced holdings plus cash, or a hedged book's gross exposure, as `portfolio show` weighs them.
  const weightBase = weightHoldings ? allocationWeightBase(weightHoldings, cashValue) : null;
  const portfolioWeightBase = weightBase?.value ?? undefined;
  const portfolioWeightBasis = weightBase?.basis;

  // The header, footer and notices move with live quotes a few times a second,
  // not on every tick.
  const portfolioSummaryTotals = useThrottledMemo(
    () => calculatePortfolioSummaryTotals(
      tickers,
      financialsMap,
      totalsCurrency,
      exchangeRates,
      isPortfolioTab,
      activeCollectionId,
      valuationBasis,
      futuresTerms.terms,
    ),
    [financialsMap],
    [activeCollectionId, exchangeRates, futuresTerms.terms, isPortfolioTab, tickers, totalsCurrency, valuationBasis],
    FOOTER_TOTALS_THROTTLE_MS,
  );

  const now = useColumnClock(columns, appActive && viewMode === "table");
  const baseColumnContext = useMemo(() => ({
    activeTab: isPortfolioTab ? activeCollectionId : undefined,
    baseCurrency: totalsCurrency,
    exchangeRates,
    valuationBasis,
    portfolioWeightBase,
    portfolioWeightBasis,
    portfolioTargets,
    supplementalVersion: supplementalData.version,
    analystResearch: supplementalData.analystResearch,
    corporateActions: supplementalData.corporateActions,
    earningsEvents: supplementalData.earningsEvents,
    perpetuals: perpetuals.markets,
    perpetualsVersion: perpetuals.version,
    futuresTerms: futuresTerms.terms,
    futuresTermsVersion: futuresTerms.version,
  }), [
    activeCollectionId,
    exchangeRates,
    futuresTerms,
    isPortfolioTab,
    perpetuals,
    portfolioTargets,
    portfolioWeightBase,
    portfolioWeightBasis,
    supplementalData,
    totalsCurrency,
    valuationBasis,
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

  // What LAST shows for each row, snapshotted when the table goes out of sight.
  const priceColumn = viewMode === "table" ? columns.find((column) => column.id === "price") : undefined;
  const lastSeenInputsRef = useRef({ tickers, financialsMap, columnContext });
  lastSeenInputsRef.current = { tickers, financialsMap, columnContext };
  const readLastPrices = useCallback(() => {
    const prices = new Map<string, number>();
    const inputs = lastSeenInputsRef.current;
    if (!priceColumn) return prices;
    for (const ticker of inputs.tickers) {
      const price = getSortValue(priceColumn, ticker, inputs.financialsMap.get(ticker.metadata.ticker), inputs.columnContext);
      if (typeof price === "number") prices.set(ticker.metadata.ticker, price);
    }
    return prices;
  }, [priceColumn]);
  const appFocused = useAppActive();
  const paneVisible = usePaneVisible();
  // Away is out of sight, not out of focus: a PF beside the focused pane is still watched.
  const { recap: sinceLastSeen, dismiss: dismissSinceLastSeen } = useSinceLastSeen({
    paneKey: paneInstance?.instanceId,
    present: appFocused && paneVisible,
    afterMs: priceColumn ? sinceLastSeenAfterMs(paneSettings.sinceLastSeen) : null,
    readPrices: readLastPrices,
    pricesVersion: financialsMap,
    resetKey: `${activeCollectionId}|${viewMode}`,
  });

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
  // Cash entered by hand gets its own figures; a broker account's cash is already in the header.
  const manualCash = useMemo(() => {
    if (!isPortfolioTab || accountState || (cashLine == null && portfolioTargets?.[CASH_SYMBOL] == null)) return null;
    const allocation = buildPortfolioAllocation({
      holdings: portfolioSummaryTotals.allocationHoldings ?? [],
      cashValue: cashValue ?? (cashLine ? Number.NaN : null),
      targets: portfolioTargets,
    });
    return allocation.cash ? { ...allocation.cash, total: allocation.total } : null;
  }, [accountState, cashLine, cashValue, isPortfolioTab, portfolioSummaryTotals, portfolioTargets]);
  const summarySegments = useMemo(() => buildPortfolioSummarySegments({
    totals: portfolioSummaryTotals,
    accountState: summaryAccountState,
    isPortfolioTab,
    convertAccountValue,
    currency: totalsCurrency,
    baseCurrency: config.baseCurrency,
    manualCash,
    brokerPortfolio,
    valuationBasis,
  }), [brokerPortfolio, config.baseCurrency, convertAccountValue, isPortfolioTab, manualCash, portfolioSummaryTotals, summaryAccountState, totalsCurrency, valuationBasis]);
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
  const { strip: tabStrip, rows: headerHeight } = usePaneTabs(showCollectionTabs
    ? {
      tabs: collectionTabs,
      activeValue: activeCollectionId,
      onSelect: handleCollectionSelect,
      focused: focused && !quickAddFocused,
      compact: true,
    }
    : null);
  const summaryHeight = summaryLayout.row.length > 0 && height > headerHeight + 2 ? 1 : 0;
  // The table keeps the paging keys, so the drawer shows its balances rather than
  // scrolling them: it grows to fit, up to half the body once past six rows.
  const bodyRows = height - (headerHeight + summaryHeight);
  const drawerLimit = Math.max(1, Math.min(bodyRows - 2, Math.max(6, Math.floor(bodyRows / 2))));
  const drawerHeight = showCashDrawer && cashDrawerExpanded
    ? Math.min(cashMarginDrawerHeight(accountState, summaryLayout.detail.length), drawerLimit)
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
    setSortPreference(nextHeaderSort(activeSort, columnId, { resetTo: { columnId: null, direction: "asc" } }));
  }, [activeSort.columnId, activeSort.direction, setSortPreference]);

  const openTickerFloating = useCallback((symbol: string, options?: { newPane?: boolean }) => {
    activateTicker(symbol, { floating: true, newPane: options?.newPane });
  }, [activateTicker]);

  const toggleViewMode = useCallback(() => {
    if (!isPortfolioTab) return;
    setViewMode((current) => current === "table" ? "grid" : "table");
  }, [isPortfolioTab, setViewMode]);

  // A perpetual opens PERP on its market's history, as its PERP% and FUND 8H cells do; any other row its research.
  const handleRowActivate = useCallback((ticker: TickerRecord) => {
    flushCursorSymbol(ticker.metadata.ticker);
    const perpetual = perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange);
    if (perpetual) openPerpMarket(perpetual.marketId);
    else openTickerFloating(ticker.metadata.ticker);
  }, [flushCursorSymbol, openPerpMarket, openTickerFloating]);
  const handleTickerAdded = useCallback((symbol: string) => {
    setCursorSymbol(symbol, { immediate: true });
  }, [setCursorSymbol]);

  const openTickerInNewPane = useCallback((ticker: TickerRecord) => {
    flushCursorSymbol(ticker.metadata.ticker);
    openTickerFloating(ticker.metadata.ticker, { newPane: true });
  }, [flushCursorSymbol, openTickerFloating]);

  // `c` (cash), `d` (delete), and `s` (table or grid) are footer hints, which
  // bind their own keys in both views; the table only adds Shift+Enter.
  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!focused) return;
    // The next key clears the moves since last seen, as a click in the table does.
    dismissSinceLastSeen();

    const key = event.name;
    const isEnter = key === "enter" || key === "return";

    if (isEnter && event.shift && !event.ctrl && !event.meta && !event.alt) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const ticker = sortedTickers[safeSelectedIdx];
      if (ticker) openTickerInNewPane(ticker);
      return true;
    }

    return false;
  }, [dismissSinceLastSeen, focused, openTickerInNewPane, safeSelectedIdx, sortedTickers]);

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
      : brokerPortfolio && !accountState ? "Acct missing" : undefined,
    brokerOffline: brokerPortfolio && offline ? { dated: offline.syncedAt != null } : undefined,
    financialsMap,
    isPortfolioTab,
    refreshingSize,
    sortedTickers,
    totals: portfolioSummaryTotals,
  }), [financialsMap, sortedTickers], [
    accountState,
    accountsError,
    brokerPortfolio,
    isPortfolioTab,
    offline,
    portfolioSummaryTotals,
    refreshingSize,
    summaryAccountState,
  ], FOOTER_TOTALS_THROTTLE_MS);
  const fxWarning = !!(fxStatus.stale || fxStatus.unknownTime || fxStatus.unavailable);
  const summaryNotices = isPortfolioTab
    ? buildPortfolioSummaryNotices({
      totals: portfolioSummaryTotals,
      accountState: summaryAccountState,
      baseCurrency: totalsCurrency,
      convertAccountValue,
      fxStatus: fxWarning ? fxStatus : undefined,
    })
    : fxWarning ? [`FX ${fxStatusText}`] : [];

  const dispatch = useAppDispatch();
  const dialog = useDialog();
  const appStateRef = useAppStateRef();
  const { notify } = usePluginAppActions();
  const removalCollection = useMemo(
    () => removableCollection(config, activeCollectionId),
    [activeCollectionId, config],
  );
  const selectedTicker = cursorSymbol ? tickerBySymbol.get(cursorSymbol) : undefined;
  const sortedTickersRef = useRef(sortedTickers);
  sortedTickersRef.current = sortedTickers;
  const removingRef = useRef(false);
  // Asks first: a manual portfolio's position goes with the row, and a stray
  // key should not take either.
  const removeSelectedTicker = useCallback(async () => {
    if (!removalCollection || !selectedTicker || removingRef.current) return;
    const symbol = selectedTicker.metadata.ticker;
    const collection = removalCollection;
    removingRef.current = true;
    try {
      const confirmed = await confirmDialog(dialog, {
        title: tf("Remove {symbol} from {collection}?", { symbol, collection: collection.name }),
        body: tickerRemovalSummary(selectedTicker, collection),
        confirmLabel: "Remove",
      });
      if (!confirmed) return;

      // The record as it is now, in case a sync touched it while the dialog was open.
      const current = appStateRef.current.tickers.get(symbol) ?? selectedTicker;
      const result = removeTickerFromCollection(current, collection);
      if (!result.changed) {
        notify({ type: "info", body: tf("{symbol} is not in {collection}.", { symbol, collection: collection.name }) });
        return;
      }
      const registry = getSharedRegistry();
      if (!registry) throw new Error("No ticker repository");
      await registry.tickerRepository.saveTicker(result.ticker);
      const symbols = sortedTickersRef.current.map((ticker) => ticker.metadata.ticker);
      setCursorSymbol(cursorAfterRemoval(symbols, symbol), { immediate: true });
      dispatch({ type: "UPDATE_TICKER", ticker: result.ticker });
      notify({ type: "success", body: tf("Removed {symbol} from {collection}.", { symbol, collection: collection.name }) });
    } catch {
      notify({ type: "error", body: tf("Failed to remove {symbol}.", { symbol }) });
    } finally {
      removingRef.current = false;
    }
  }, [appStateRef, dialog, dispatch, notify, removalCollection, selectedTicker, setCursorSymbol]);

  // The cursor row's perpetual, for the keyboard: the pane menu opens what clicking its cell opens. A row that is a
  // perpetual market opens its own, as Enter does.
  const cursorPerpetual = showsPerpetuals && cursorSymbol ? perpetuals.markets.get(cursorSymbol) ?? null : null;
  const cursorMarket = useMemo(() => selectedTicker ? perpetualListing(selectedTicker.metadata.ticker, selectedTicker.metadata.exchange) : null,
    [selectedTicker]);
  usePaneMenuItems("portfolio-list-perpetual", () => cursorPerpetual
    ? [{ id: "open-perpetual", label: openPerpLabel(cursorPerpetual), onSelect: () => openPerpMarket(cursorPerpetual.marketId) }]
    : cursorMarket
      ? [{ id: "open-perpetual", label: tf("Open {label}", { label: `PERP ${perpetualDisplaySymbol(cursorMarket)} · ${perpetualVenueName(cursorMarket.exchange)}` }),
        onSelect: () => openPerpMarket(cursorMarket.marketId) }]
      : null, [cursorMarket, cursorPerpetual, openPerpMarket]);

  usePaneFooter("portfolio-list", () => ({
    info: [
      ...offlineBrokerFooter.asOf,
      ...summaryFooterInfo,
      ...offlineBrokerFooter.status,
      ...(fxStatusText && !fxWarning ? [{ id: "fx", parts: [{ text: `FX ${fxStatusText}`, tone: "muted" as const }] }] : []),
      ...(showsPerpetuals && perpetuals.stale ? [{ id: "perpetuals", parts: [{ text: "perpetuals stale", tone: "warning" as const }] }] : []),
    ],
    hints: [
      ...offlineBrokerFooter.hints,
      ...(removalCollection
        ? [{
            id: "delete",
            key: "d",
            label: "elete",
            title: tf("Remove from {collection}", { collection: removalCollection.name }),
            onPress: () => { void removeSelectedTicker(); },
            disabled: !selectedTicker,
          }]
        : []),
      ...(showCashDrawer
        ? [{
            id: "cash",
            key: "c",
            label: "ash",
            onPress: () => setCashDrawerExpanded(!cashDrawerExpanded),
          }]
        : []),
      // Watchlists have no grid, so only a portfolio offers the switch.
      ...(isPortfolioTab
        ? [{
            id: "view",
            key: "s",
            label: viewMode === "table" ? " grid" : " table",
            title: viewMode === "table" ? "Grid View" : "Table View",
            onPress: toggleViewMode,
          }]
        : []),
    ],
  }), [
    cashDrawerExpanded,
    fxStatusText,
    fxWarning,
    isPortfolioTab,
    offlineBrokerFooter,
    perpetuals.stale,
    removalCollection,
    removeSelectedTicker,
    selectedTicker,
    setCashDrawerExpanded,
    showCashDrawer,
    showsPerpetuals,
    summaryFooterInfo,
    toggleViewMode,
    viewMode,
  ]);

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
  const requestQuickAdd = useCallback(() => setQuickAddRequest((count) => count + 1), []);
  const quickAddHeight = showQuickAdd ? 1 : 0;
  const selectedFinancials = cursorSymbol ? financialsMap.get(cursorSymbol) : undefined;
  const selectedCap = liveMarketCapitalization(selectedFinancials?.quote, selectedFinancials?.fundamentals);
  // A cap repriced from the live price has no stale valuation date to explain.
  const capNotice = viewMode === "table" && columns.some((column) => column.id === "market_cap")
    && selectedCap?.provenance.kind === "fundamentals" && !selectedCap.live
    ? `${cursorSymbol} market cap: ${describeFundamentalMarketCap(selectedCap.provenance)}.` : undefined;
  const multiplierNotice = isPortfolioTab && selectedTicker && hasUnknownOptionMultiplier(selectedTicker, activeCollectionId)
    ? `${cursorSymbol} has no contract multiplier; its value assumes 1x.` : undefined;
  // The row's change cells say DELISTED; the notice gives its last session.
  const selectedDelisting = selectedFinancials?.quote?.delisting;
  const delistedNotice = selectedDelisting ? `${cursorSymbol}: ${delistingLabel(selectedDelisting)}.` : undefined;
  usePaneNoticeFooter({
    registrationId: "portfolio-list-notices",
    notices: [...summaryNotices, delistedNotice, capNotice, multiplierNotice].filter((notice): notice is string => !!notice),
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
      focusRequest={quickAddRequest}
    />
  ) : null;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabStrip && (
        <Box flexDirection="column" height={headerHeight}>
          <Box flexDirection="row" height={1}>
            <Box flexShrink={1} overflow="hidden">{tabStrip}</Box>
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
          sinceLastSeen={sinceLastSeen}
          onRootKeyDown={handleTableKeyDown}
          onTableMouseDown={dismissSinceLastSeen}
          onVisibleRangeChange={handleVisibleRangeChange}
          visibleRangeBuffer={3}
          resetScrollKey={activeCollectionId}
          onRowActivate={handleRowActivate}
          onAddTicker={showQuickAdd ? requestQuickAdd : undefined}
          onOpenPerpetual={showsPerpetuals ? openPerpMarket : undefined}
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
          onOpenInNewPane={openTickerInNewPane}
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
