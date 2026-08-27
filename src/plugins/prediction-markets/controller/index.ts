import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { useViewport } from "../../../react/input";
import { useAppInputCapture } from "../../../state/app/input-capture";
import { usePaneInstance } from "../../../state/app/context";
import {
  useDebouncedPluginPaneState,
  usePluginPaneState,
  usePluginState,
} from "../../runtime";
import { usePredictionMarketsDataState } from "./data";
import { usePredictionControllerEffects } from "./effects";
import { usePredictionControllerKeyboard } from "./keyboard";
import { getDefaultPredictionSort, getNextPredictionSort } from "../metrics";
import {
  getPredictionMarketsPaneSettings,
  resolvePredictionColumns,
} from "../settings";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionDetailTab,
  PredictionHistoryRange,
  PredictionListRow,
  PredictionSortPreference,
  PredictionVenueScope,
} from "../types";

const KEYBOARD_DETAIL_LOAD_DELAY_MS = 140;
const SELECTION_PERSIST_DEBOUNCE_MS = 300;

export function usePredictionMarketsController({
  focused,
}: {
  focused: boolean;
}) {
  const paneInstance = usePaneInstance();
  const paneSettings = useMemo(
    () => getPredictionMarketsPaneSettings(paneInstance?.settings),
    [paneInstance?.settings],
  );
  const initialParams = paneInstance?.params;

  const [watchlist, setWatchlist] = usePluginState<string[]>(
    "watchlist:v1",
    [],
  );
  const [lastVenueScope, setLastVenueScope] =
    usePluginState<PredictionVenueScope>("lastVenueScope:v1", "all");

  const [venueScope, setVenueScope] = usePluginPaneState<PredictionVenueScope>(
    "venueScope",
    paneSettings.hideTabs ? paneSettings.lockedVenueScope : lastVenueScope,
  );
  const [browseTab, setBrowseTab] = usePluginPaneState<PredictionBrowseTab>(
    "browseTab",
    paneSettings.defaultBrowseTab,
  );
  const [storedDetailTab, setDetailTab] = usePluginPaneState<PredictionDetailTab>(
    "detailTab",
    "overview",
  );
  const detailTab = storedDetailTab === "chart" ? "overview" : storedDetailTab;
  useEffect(() => {
    if (storedDetailTab === "chart") setDetailTab("overview");
  }, [setDetailTab, storedDetailTab]);
  const [searchQuery, setSearchQuery] = usePluginPaneState<string>(
    "searchQuery",
    "",
  );
  const [categoryId, setCategoryId] = usePluginPaneState<PredictionCategoryId>(
    "categoryId",
    "all",
  );
  const [historyRange, setHistoryRange] =
    usePluginPaneState<PredictionHistoryRange>("historyRange", "1M");
  const [selectedRowKey, setSelectedRowKey] =
    useDebouncedPluginPaneState<string | null>(
      "selectedRowKey",
      null,
      SELECTION_PERSIST_DEBOUNCE_MS,
    );
  const [selectedDetailMarketKey, setSelectedDetailMarketKey] =
    useDebouncedPluginPaneState<string | null>(
      "selectedDetailMarketKey",
      null,
      SELECTION_PERSIST_DEBOUNCE_MS,
    );
  const defaultSortPreference = useMemo(
    () => getDefaultPredictionSort(paneSettings.defaultBrowseTab),
    [paneSettings.defaultBrowseTab],
  );
  const [sortPreference, setSortPreference] =
    usePluginPaneState<PredictionSortPreference>(
      "sortPreference",
      defaultSortPreference,
    );
  const [detailOpen, setDetailOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [initialParamsApplied, setInitialParamsApplied] = useState(false);
  const appViewport = useViewport();
  useAppInputCapture(focused && searchFocused);

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const searchInputRef = useRef<InputRenderable>(null);
  const previousFilterResetKeyRef = useRef<string | null>(null);

  const effectiveVenueScope = paneSettings.hideTabs
    ? paneSettings.lockedVenueScope
    : venueScope;
  const includePolymarket =
    effectiveVenueScope === "all" || effectiveVenueScope === "polymarket";
  const includeKalshi =
    effectiveVenueScope === "all" || effectiveVenueScope === "kalshi";
  const watchlistSet = useMemo(() => new Set(watchlist), [watchlist]);
  const visibleColumns = useMemo(
    () => resolvePredictionColumns(paneSettings.columnIds),
    [paneSettings.columnIds],
  );

  const data = usePredictionMarketsDataState({
    browseTab,
    categoryId,
    detailOpen,
    effectiveVenueScope,
    focused,
    historyRange,
    includeKalshi,
    includePolymarket,
    searchQuery,
    selectedDetailMarketKey,
    selectedRowKey,
    sortPreference,
    watchlistSet,
  });

  usePredictionControllerEffects({
    appViewportHeight: appViewport.height,
    browseTab,
    categoryId,
    debouncedSearchQuery: data.debouncedSearchQuery,
    detailOpen,
    effectiveVenueScope,
    headerScrollRef,
    hideTabs: paneSettings.hideTabs,
    initialParams,
    initialParamsApplied,
    lastVenueScope,
    lockedVenueScope: paneSettings.lockedVenueScope,
    previousFilterResetKeyRef,
    scrollRef,
    searchFocused,
    searchInputRef,
    selectedDetailMarketKey,
    selectedIndex: data.selectedIndex,
    selectedRow: data.selectedRow,
    selectedRowKey,
    setDetailOpen,
    setInitialParamsApplied,
    setLastVenueScope,
    setSearchQuery,
    setSelectedDetailMarketKey,
    setSelectedRowKey,
    setVenueScope,
    visibleRowsLength: data.visibleRows.length,
  });

  useEffect(() => {
    setSortPreference((current) =>
      current.columnId === defaultSortPreference.columnId &&
      current.direction === defaultSortPreference.direction
        ? current
        : defaultSortPreference,
    );
  }, [defaultSortPreference, setSortPreference]);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
  }, []);

  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const toggleWatchlist = useCallback(
    (row: PredictionListRow) => {
      const rowMarketKeys = [...new Set(row.watchMarketKeys)];
      setWatchlist((current) => {
        const allWatched = rowMarketKeys.every((marketKey) =>
          current.includes(marketKey),
        );
        if (allWatched) {
          return current.filter((entry) => !rowMarketKeys.includes(entry));
        }
        return [...new Set([...current, ...rowMarketKeys])];
      });
    },
    [setWatchlist],
  );

  const setBrowseSelection = useCallback(
    (rowKey: string, options?: { debounceDetail?: boolean }) => {
      setSearchFocused(false);
      data.actions.setNextDetailLoadDelay(
        options?.debounceDetail ? KEYBOARD_DETAIL_LOAD_DELAY_MS : 0,
      );
      setSelectedRowKey(rowKey, {
        immediate: !options?.debounceDetail || selectedRowKey == null,
      });
    },
    [data.actions, selectedRowKey, setSelectedRowKey],
  );

  const openSelectedRow = useCallback(
    (rowKey: string) => {
      const row = data.visibleRows.find((candidate) => candidate.key === rowKey);
      if (!row) return;
      setSearchFocused(false);
      data.actions.setNextDetailLoadDelay(0);
      setSelectedRowKey(row.key, { immediate: true });
      setSelectedDetailMarketKey(row.focusMarketKey, { immediate: true });
      setDetailOpen(true);
    },
    [data.actions, data.visibleRows, setSelectedDetailMarketKey, setSelectedRowKey],
  );

  const selectMarket = useCallback(
    (marketKey: string) => {
      setSearchFocused(false);
      data.actions.setNextDetailLoadDelay(0);
      const row = data.visibleRows.find((candidate) =>
        candidate.markets.some((market) => market.key === marketKey),
      );
      if (!row) {
        setDetailOpen(false);
        setSelectedRowKey(null);
        setSelectedDetailMarketKey(null);
        return;
      }
      setSelectedRowKey(row.key, { immediate: true });
      setSelectedDetailMarketKey(marketKey, { immediate: true });
      setDetailOpen(true);
    },
    [
      data.actions,
      data.visibleRows,
      setDetailOpen,
      setSelectedDetailMarketKey,
      setSelectedRowKey,
    ],
  );

  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    setSearchFocused(false);
  }, []);

  const setVenue = useCallback(
    (nextVenueScope: string) => {
      const typed = nextVenueScope as PredictionVenueScope;
      setSearchFocused(false);
      setVenueScope(typed);
      setLastVenueScope(typed);
    },
    [setLastVenueScope, setVenueScope],
  );

  const selectBrowseTab = useCallback(
    (nextBrowseTab: PredictionBrowseTab) => {
      setSearchFocused(false);
      setBrowseTab(nextBrowseTab);
    },
    [setBrowseTab],
  );

  const selectCategory = useCallback(
    (nextCategoryId: PredictionCategoryId) => {
      setSearchFocused(false);
      setCategoryId(nextCategoryId);
    },
    [setCategoryId],
  );

  const handleSortHeaderClick = useCallback(
    (columnId: string) => {
      setSearchFocused(false);
      setSortPreference((current) => getNextPredictionSort(current, columnId));
    },
    [setSortPreference],
  );

  usePredictionControllerKeyboard({
    categoryId,
    detailOpen,
    detailScrollRef,
    detailTab,
    effectiveVenueScope,
    focused,
    hideTabs: paneSettings.hideTabs,
    searchFocused,
    selectedRow: data.selectedRow,
    selectedSummaryKey: data.selectedSummaryKey,
    sortedOutcomeMarkets: data.sortedOutcomeMarkets,
    blurSearch,
    focusSearch,
    selectBrowseTab,
    selectCategory,
    selectMarket,
    setVenue,
    toggleWatchlist,
  });

  const searchPending = searchQuery.trim() !== data.debouncedSearchQuery.trim();
  const searchLoading =
    searchQuery.trim().length > 0 && (searchPending || data.catalogLoadCount > 0);

  return {
    paneSettings,
    browseTab,
    categoryId,
    catalogHasMore: data.catalogHasMore,
    catalogLoadCount: data.catalogLoadCount,
    catalogLoadingMore: data.catalogLoadingMore,
    catalogStatus: data.catalogStatus,
    detail: data.detail,
    detailError: data.detailError,
    detailLoadCount: data.detailLoadCount,
    detailOpen,
    detailScrollRef,
    detailTab,
    effectiveVenueScope,
    headerScrollRef,
    historyRange,
    lastRefreshAt: data.lastRefreshAt,
    scrollRef,
    searchFocused,
    searchInputRef,
    searchLoading,
    searchQuery,
    selectedRow: data.selectedRow,
    selectedIndex: data.selectedIndex,
    selectedSummary: data.selectedSummary,
    sortPreference,
    transportState: data.transportState,
    visibleColumns,
    visibleRows: data.visibleRows,
    watchlistSet,
    actions: {
      blurSearch,
      closeDetail,
      loadMoreCatalog: data.loadMoreCatalog,
      focusSearch,
      handleSortHeaderClick,
      openSelectedRow,
      selectBrowseTab,
      selectCategory,
      selectMarket,
      setDetailTab,
      setBrowseSelection,
      setHistoryRange,
      setSearchQuery,
      setVenue,
      toggleWatchlist,
    },
  };
}
