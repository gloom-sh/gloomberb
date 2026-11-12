import { listHomeMarket } from "../../../../portfolio/listed-symbol";
import { Box, useUiCapabilities } from "../../../../ui";
import { brokerPortfolioLogo } from "../../../../brokers/logos";
import { LogoMark } from "../../../../components/ui/logo-mark";
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
import { useAnsweredSnapshots, useFxRatesMap, useTickerFinancialsMap } from "../../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../../market-data/portfolio-financials";
import { useAppActive, useAppVisible, usePaneVisible } from "../../../../state/app/activity";
import { t, tf } from "../../../../i18n";
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
import type { TickerFinancials } from "../../../../types/financials";
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
import { useQuoteDelayFooter } from "../../shared/cloud-upgrade";
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
import { usePluginAppActions, usePluginBrokerActions } from "../../../runtime";
import { useFxDayMoves } from "./fx-day-moves";
import { isManualPortfolio } from "../../../../portfolio/mutations";
import {
  cursorAfterRemoval,
  removableCollection,
  removeTickerFromCollection,
  tickerRemovalSummary,
} from "./remove-ticker";
import { QUICK_ADD_KEY, QuickAddTickerInput, type QuickAddCollectionKind } from "../quick-add";
import { usePositionsImport } from "../positions-import";
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
import { useUtcDay } from "../../../../react/auto-refresh";
import { perpetualDisplaySymbol, perpetualListing, perpetualVenueName } from "../../../../tickers/perpetual-listing";
import { useColumnClock } from "../use-column-clock";
import { liveMarketCapitalization } from "../../../../market-data/quotes/live-valuation";
import { hasUnknownOptionMultiplier } from "../../../../portfolio/position-metrics";
import { sharePositionMetrics } from "../../../../portfolio/column-values";
import { withFuturesContractSizes } from "../../../../portfolio/futures-positions";
import { withPurchaseDateCostFx } from "../../../../portfolio/cost-fx";
import { usePortfolioFuturesTerms } from "./futures-terms";
import { useFuturesFrontNotes } from "./futures-front";
import { usePurchaseDateCostFx } from "./purchase-date-fx";
import { periodFxLine, periodPnlLabel, periodPnlNotices, usePanePeriodPnl } from "./period-pnl";
import type { LoadedPeriodPnl } from "../period-pnl";
import {
  allocationFigures,
  allocationWeightBase,
  buildPortfolioAllocation,
  CASH_SYMBOL,
  hasTargetWeights,
  resolvePortfolioCash,
} from "../../../../portfolio/allocation";
import { allocationSummaryRows, CASH_ROW_KEY } from "../allocation-rows";
import { useTargetWeightActions, type TargetRow } from "./target-weights";

/** Columns that need the portfolio's total. */
const ALLOCATION_COLUMN_IDS = new Set(["weight", "drift", "trade", "trade_value"]);

// Rows follow every tick. Totals walk the whole collection, so the footer
// coalesces to about four updates a second and the weight denominator to one.
const FOOTER_TOTALS_THROTTLE_MS = 250;
const WEIGHT_TOTAL_THROTTLE_MS = 1_000;
const DAY_MS = 86_400_000;
/** DRIFT sorts by its size, so its first click puts the largest drift on top. */
const firstSortDirection = (columnId: string) => columnId === "drift" ? "desc" as const : "asc" as const;
/** One fallback for every render: a fresh `{}` would read as a changed value each time. */
const NO_COLLECTION_SORTS: Record<string, CollectionSortPreference> = {};
/** What the pane's `cursorSummaryRow` holds while the cursor is on the CASH row. */
const CASH_SUMMARY_ROW = "cash";

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
  // The CASH row's cursor has a key of its own: `cursorSymbol`, which followers, recent tickers and saved layouts
  // read, only ever holds a ticker, and keeps the last one while the cursor is on cash.
  const [cursorSummaryRow, setCursorSummaryRow] = usePaneStateValue<string | null>("cursorSummaryRow", null);
  const committedCursorRow = cursorSummaryRow === CASH_SUMMARY_ROW ? CASH_ROW_KEY : committedCursorSymbol;
  const commitCursorRow = useCallback((row: string | null) => {
    if (row === CASH_ROW_KEY) {
      setCursorSummaryRow(CASH_SUMMARY_ROW);
      return;
    }
    setCursorSummaryRow(null);
    setCommittedCursorSymbol(row);
  }, [setCommittedCursorSymbol, setCursorSummaryRow]);
  const [collectionSorts, setCollectionSorts] = usePaneStateValue<Record<string, CollectionSortPreference>>("collectionSorts", NO_COLLECTION_SORTS);
  const [cashDrawerExpanded, setCashDrawerExpanded] = usePaneStateValue<boolean>("cashDrawerExpanded", false);
  const [, setViewMode] = usePaneSettingValue<PortfolioViewMode>("viewMode", "table");

  const [streamWindow, setStreamWindow] = useState({ start: 0, end: 24 });
  const [quickAddFocused, setQuickAddFocused] = useState(false);

  const {
    cursorSymbol,
    setCursorSymbol,
    flushCursorSymbol,
    cancelPendingCursorSymbol,
  } = useThrottledCursorSymbol(committedCursorRow, commitCursorRow);

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
  // Totals, money columns and account values are in the portfolio's currency.
  const totalsCurrency = useMemo(
    () => resolvePortfolioTotalsCurrency(currentPortfolio, config.baseCurrency),
    [config.baseCurrency, currentPortfolio],
  );
  // A future counts contracts of the size its terms give, and at the close is valued at its settlement.
  const futuresTerms = usePortfolioFuturesTerms(collectionTickers, { enabled: true, settlement: isPortfolioTab && valuationBasis === "regular-close" });
  const futuresFrontNotes = useFuturesFrontNotes(futuresTerms.terms, { enabled: appActive && viewMode === "table", liveStreaming });
  // A dated lot in another currency costs what its purchase date's FX close says in that currency, as portfolio show values it.
  const purchaseDateFx = usePurchaseDateCostFx(collectionTickers, { enabled: isPortfolioTab, portfolioId: activeCollectionId, into: totalsCurrency });
  const tickers = useMemo(
    () => withPurchaseDateCostFx(withFuturesContractSizes(collectionTickers, futuresTerms.terms), purchaseDateFx, totalsCurrency, activeCollectionId),
    [activeCollectionId, collectionTickers, futuresTerms.terms, purchaseDateFx, totalsCurrency],
  );
  const financialsInstrumentOptions = useMemo(() => ({
    portfolioId: isPortfolioTab ? activeCollectionId : undefined,
  }), [activeCollectionId, isPortfolioTab]);
  const marketFinancialsMap = useTickerFinancialsMap(tickers, financialsInstrumentOptions);
  // Until a row's snapshot answers, a dash in its company columns may still fill in: PF hides none yet.
  const answeredSnapshots = useAnsweredSnapshots(tickers, financialsInstrumentOptions);
  const financialsMap = useMemo(
    () => buildPortfolioFinancialsMap(tickers, cachedFinancials, marketFinancialsMap, financialsInstrumentOptions),
    [tickers, cachedFinancials, marketFinancialsMap, financialsInstrumentOptions],
  );
  // P&L between two closes (the pane's P&L From), as portfolio show --from reads it; since cost without one.
  const periodPnl = usePanePeriodPnl({
    from: paneSettings.pnlFrom,
    to: paneSettings.pnlTo,
    enabled: isPortfolioTab,
    portfolioId: activeCollectionId,
    tickers: collectionTickers,
    currency: totalsCurrency,
    futures: futuresTerms.terms,
    futuresVersion: futuresTerms.version,
    financialsMap,
    snapshot: (paneInstance?.settings?.periodPnlSnapshot ?? null) as LoadedPeriodPnl | null,
  });
  const periodColumns = periodPnl?.window ? periodPnl : null;
  const valueFlashingEnabled = useAppSelector((state) => state.config.valueFlashingEnabled);
  const flashSymbols = useQuoteFlashMap(financialsMap, valueFlashingEnabled);

  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState, accountsError, offline } = usePortfolioAccountState(currentPortfolio, accountStateInput);
  const brokerPortfolio = isPortfolioTab && !!currentPortfolio?.brokerInstanceId;
  // The positions stay as last synced while the broker is away, dated, with one key to bring it back.
  const offlineBrokerFooter = useOfflineBrokerFooter(brokerPortfolio ? offline : null);
  const portfolioTargets = currentPortfolio?.targetWeights;
  // A boolean, so a quote tick does not rebuild the columns.
  const otherCurrencies = holdsOtherCurrencies(tickers, financialsMap, totalsCurrency);
  const columns = useMemo(
    () => resolveVisibleColumns(paneSettings.columnIds, isPortfolioTab, { targetWeights: hasTargetWeights(currentPortfolio), otherCurrencies }),
    [currentPortfolio, isPortfolioTab, otherCurrencies, paneSettings.columnIds],
  );
  const supplementalData = usePortfolioSupplementalData(tickers, columns, appActive, financialsMap);
  // One lookup for the whole list, only while a perpetual column is on screen.
  const showsPerpetuals = viewMode === "table" && columns.some((column) => PERPETUAL_COLUMN_IDS.has(column.id));
  // The rows in view, from the last render: their contracts follow the quote stream.
  const [perpetualsInView, setPerpetualsInView] = useState<ReadonlySet<string>>(() => new Set());
  const perpetuals = useListPerpetuals(tickers, showsPerpetuals, perpetualsInView);
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
  // The day's move of a holding in another currency holds that currency's move, as `portfolio show` counts it.
  const fxDayMoves = useFxDayMoves(isPortfolioTab ? trackedCurrencies : [], totalsCurrency);
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
      fxDayMoves,
    ),
    [financialsMap],
    [activeCollectionId, exchangeRates, futuresTerms.terms, fxDayMoves, isPortfolioTab, tickers, totalsCurrency, valuationBasis],
    FOOTER_TOTALS_THROTTLE_MS,
  );

  const now = useColumnClock(columns, appActive && viewMode === "table");
  // A row outside the list's home market shows its venue (BA:LSE in a US list).
  const homeMarket = useMemo(() => listHomeMarket(collectionTickers), [collectionTickers]);
  const baseColumnContext = useMemo(() => ({
    activeTab: isPortfolioTab ? activeCollectionId : undefined,
    homeMarket,
    baseCurrency: totalsCurrency,
    exchangeRates,
    fxDayMoves,
    // A watchlist values nothing: its LAST is the regular session's, as `quote` heads it.
    ...(isPortfolioTab ? { valuationBasis } : {}),
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
    ...(periodColumns ? { periodPnl: { rows: periodColumns.rows, pending: periodColumns.pending, fx: periodFxLine(periodColumns.result) }, periodPnlVersion: periodColumns.version } : {}),
  }), [
    activeCollectionId,
    exchangeRates,
    fxDayMoves,
    futuresTerms,
    homeMarket,
    isPortfolioTab,
    periodColumns,
    perpetuals,
    portfolioTargets,
    portfolioWeightBase,
    portfolioWeightBasis,
    supplementalData,
    totalsCurrency,
    valuationBasis,
  ]);
  // Cells and sort keys share each row's position figures: the clock does not move them.
  const columnContext: ColumnContext = useMemo(() => sharePositionMetrics({ ...baseColumnContext, now }, baseColumnContext), [baseColumnContext, now]);
  // The order only follows the per-second clock when sorting by quote age;
  // day-based columns read the day, which the day's start stands for.
  const sortNow = activeSort.columnId === "latency" ? now : Math.floor(now / DAY_MS) * DAY_MS;
  const sortContext: ColumnContext = useMemo(() => sharePositionMetrics({ ...baseColumnContext, now: sortNow }, baseColumnContext), [baseColumnContext, sortNow]);

  const candidateSort = useMemo(
    () => sortTickers(tickers, financialsMap, activeSort, sortContext, columns),
    [tickers, financialsMap, activeSort, sortContext, columns],
  );
  const candidateSymbols = useMemo(
    () => candidateSort.tickers.map((ticker) => ticker.metadata.ticker),
    [candidateSort],
  );
  const orderResetKey = `${activeCollectionId}|${activeSort.columnId ?? ""}|${activeSort.direction}`;
  // Rows getting their first figure (the quotes landing after the rows) take their place at once.
  const orderedSymbols = useThrottledTickerOrder(candidateSymbols, orderResetKey, { valuedSymbols: candidateSort.valued });
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
  // Under the holdings of a book with cash entered by hand or targets, its CASH and TOTAL rows, as
  // `portfolio show` prints them: cash takes a target and a trade like a holding, so the trades add up.
  const showsAllocationRows = isPortfolioTab && viewMode === "table" && !paneSettings.hideCash
    && (cashLine?.source === "manual" || hasTargetWeights(currentPortfolio));
  const allocationRows = useMemo(() => {
    if (!showsAllocationRows) return undefined;
    const allocation = buildPortfolioAllocation({
      holdings: portfolioSummaryTotals.allocationHoldings ?? [],
      cashValue: cashValue ?? (cashLine ? Number.NaN : null),
      targets: portfolioTargets,
    });
    return allocationSummaryRows(allocation, { cashCurrency: cashLine?.currency, currency: totalsCurrency });
  }, [cashLine, cashValue, portfolioSummaryTotals, portfolioTargets, showsAllocationRows, totalsCurrency]);
  const cashRowShown = !!allocationRows?.some((row) => row.id === "cash");
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
    cashInTable: cashRowShown,
    period: periodColumns ? {
      label: periodPnlLabel(periodColumns),
      total: periodColumns.result?.total ?? null,
      contribution: periodColumns.result?.totalContribution ?? null,
    } : null,
  }), [brokerPortfolio, cashRowShown, config.baseCurrency, convertAccountValue, isPortfolioTab, manualCash, periodColumns, portfolioSummaryTotals, summaryAccountState, totalsCurrency, valuationBasis]);
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
  const { getBrokerAdapter, getBrokerLogo } = usePluginBrokerActions();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const collectionTabs = useMemo(() => visibleCollections.map((collection) => {
    const portfolio = desktop && collection.kind === "portfolio"
      ? config.portfolios.find((entry) => entry.id === collection.id)
      : undefined;
    // A broker account's tab leads with its broker's logo on the desktop and the web.
    const logo = portfolio ? brokerPortfolioLogo(portfolio, config.brokerInstances, getBrokerAdapter, getBrokerLogo) : null;
    return {
      label: collection.name,
      value: collection.id,
      ...(logo ? { leading: <LogoMark src={logo.src} name={logo.name} /> } : {}),
    };
  }), [config.brokerInstances, config.portfolios, desktop, getBrokerAdapter, getBrokerLogo, visibleCollections]);
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
    setSortPreference(nextHeaderSort(activeSort, columnId, {
      firstDirection: firstSortDirection,
      resetTo: { columnId: null, direction: "asc" },
    }));
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
      // The cash row opens nothing.
      const ticker = selectedIdx >= 0 ? sortedTickers[selectedIdx] : undefined;
      if (ticker) openTickerInNewPane(ticker);
      return true;
    }

    return false;
  }, [dismissSinceLastSeen, focused, openTickerInNewPane, selectedIdx, sortedTickers]);

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

    // The cash row takes the cursor too, while it is shown.
    const hasSelection = cursorSymbol && ((cursorSymbol === CASH_ROW_KEY && cashRowShown)
      || sortedTickers.some((ticker) => ticker.metadata.ticker === cursorSymbol));
    if (!hasSelection) {
      setCursorSymbol(sortedTickers[0]!.metadata.ticker, { immediate: true });
    }
  }, [cashRowShown, cursorSymbol, setCursorSymbol, sortedTickers]);

  const effectiveStreamWindow = useMemo(() => (
    viewMode === "grid"
      ? { start: 0, end: Math.min(sortedTickers.length, 96) }
      : {
        start: streamWindow.start,
        end: Math.min(sortedTickers.length, Math.max(streamWindow.end, height + 4)),
      }
  ), [height, sortedTickers.length, streamWindow, viewMode]);

  const perpetualsInViewKey = showsPerpetuals
    ? sortedTickers.slice(effectiveStreamWindow.start, effectiveStreamWindow.end).map((ticker) => ticker.metadata.ticker).join("\u001f")
    : "";
  useEffect(() => {
    setPerpetualsInView(new Set(perpetualsInViewKey ? perpetualsInViewKey.split("\u001f") : []));
  }, [perpetualsInViewKey]);

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

  // The quotes' time of today drops its day; the next day the footer names it.
  const utcDay = useUtcDay();
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
    utcDay,
  ], FOOTER_TOTALS_THROTTLE_MS);
  const fxWarning = !!(fxStatus.stale || fxStatus.unknownTime || fxStatus.unavailable);
  // Signed out or free, the rows' prices are the delayed ones; a list of coins is live and says nothing.
  const quoteDelay = useQuoteDelayFooter(rowQuotes(sortedTickers, financialsMap), "portfolio-delay");
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

  // A broker's positions export, previewed and then saved to a portfolio; the new one is shown.
  const positionsImport = usePositionsImport({
    activePortfolio: currentPortfolio,
    onImported: setCurrentCollectionId,
  });
  usePaneMenuItems("portfolio-list-import", () => [
    { id: "import-positions", label: t("Import Positions…"), onSelect: positionsImport.start },
  ], [positionsImport.start]);

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

  // The cursor row's target weight: a holding's, or the cash line's on the CASH row.
  const targetRow = useMemo<TargetRow | null>(() => {
    if (!isPortfolioTab || !currentPortfolio) return null;
    if (cursorSymbol === CASH_ROW_KEY) {
      return cashRowShown ? { cash: true, symbol: CASH_SYMBOL, label: "Cash", weight: cashWeight(cashValue, portfolioWeightBase, portfolioWeightBasis) } : null;
    }
    if (!selectedTicker) return null;
    const symbol = selectedTicker.metadata.ticker;
    const holding = weightHoldings?.find((entry) => entry.symbol === symbol);
    const weight = holding ? allocationFigures(holding, portfolioWeightBase, null).weight : null;
    return { cash: false, symbol, label: symbol, weight };
  }, [cashRowShown, cashValue, currentPortfolio, cursorSymbol, isPortfolioTab, portfolioWeightBase, portfolioWeightBasis, selectedTicker, weightHoldings]);
  const listedSymbols = useMemo(() => new Set(collectionTickers.map((ticker) => ticker.metadata.ticker)), [collectionTickers]);
  useTargetWeightActions({ portfolio: currentPortfolio, row: targetRow, listedSymbols, enabled: focused && viewMode === "table" && !quickAddFocused });

  usePaneFooter("portfolio-list", () => ({
    info: [
      ...offlineBrokerFooter.asOf,
      ...summaryFooterInfo,
      ...offlineBrokerFooter.status,
      // The delay clock beside the quotes' source and time; the FX note after it gives way first on a narrow row.
      ...(quoteDelay ? [quoteDelay] : []),
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
    quoteDelay,
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
    notices: [...summaryNotices, ...periodPnlNotices(periodPnl), delistedNotice, capNotice, multiplierNotice].filter((notice): notice is string => !!notice),
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
          futuresFrontNotes={futuresFrontNotes}
          flashSymbols={flashSymbols}
          sinceLastSeen={sinceLastSeen}
          onRootKeyDown={handleTableKeyDown}
          onTableMouseDown={dismissSinceLastSeen}
          onVisibleRangeChange={handleVisibleRangeChange}
          visibleRangeBuffer={3}
          resetScrollKey={activeCollectionId}
          onRowActivate={handleRowActivate}
          addTickerShortcut={showQuickAdd ? QUICK_ADD_KEY : undefined}
          onOpenPerpetual={showsPerpetuals ? openPerpMarket : undefined}
          rootHeight={contentHeight}
          width={width}
          answeredSnapshots={answeredSnapshots}
          exportName={activeCollectionEntry?.name}
          allocationRows={allocationRows}
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
      {positionsImport.picker}

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

/** The cash line's weight, as its row shows it: none against a hedged book's gross exposure. */
function cashWeight(cashValue: number | null, weightBase: number | undefined, basis: "total" | "gross" | undefined): number | null {
  if (cashValue == null || basis === "gross") return null;
  return allocationFigures({ held: true, marketValue: cashValue, units: 0, unitPrice: null }, weightBase, null).weight;
}

/** The quotes of the rows, in order, for the delayed clock, which stops at the first late one. */
function* rowQuotes(tickers: readonly TickerRecord[], financialsMap: ReadonlyMap<string, TickerFinancials>) {
  for (const ticker of tickers) yield financialsMap.get(ticker.metadata.ticker)?.quote;
}
