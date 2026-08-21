import { useMemo } from "react";
import { measurePerf } from "../../../utils/perf-marks";
import { usePredictionCatalogData } from "./catalog";
import { usePredictionDetailData } from "./detail";
import {
  buildPredictionVisibleRowLookup,
  resolvePredictionSelectedRowState,
  resolvePredictionSelectedSummary,
} from "./selection";
import {
  filterPredictionMarkets,
  getDefaultPredictionSort,
  sortPredictionMarkets,
} from "../metrics";
import { sortPredictionOutcomeMarkets } from "../outcome-order";
import { buildPredictionListRows } from "../rows";
import type {
  PredictionBrowseTab,
  PredictionCategoryId,
  PredictionHistoryRange,
  PredictionSortPreference,
  PredictionVenueScope,
} from "../types";

export function usePredictionMarketsDataState({
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
}: {
  browseTab: PredictionBrowseTab;
  categoryId: PredictionCategoryId;
  detailOpen: boolean;
  effectiveVenueScope: PredictionVenueScope;
  focused: boolean;
  historyRange: PredictionHistoryRange;
  includeKalshi: boolean;
  includePolymarket: boolean;
  searchQuery: string;
  selectedDetailMarketKey: string | null;
  selectedRowKey: string | null;
  sortPreference: PredictionSortPreference;
  watchlistSet: Set<string>;
}) {
  const {
    allMarkets,
    catalogHasMore,
    catalogLoadCount,
    catalogLoadingMore,
    catalogStatus,
    debouncedSearchQuery,
    loadMoreCatalog,
    setCatalogCache,
  } = usePredictionCatalogData({
    categoryId,
    includeKalshi,
    includePolymarket,
    searchQuery,
  });

  const allRows = useMemo(
    () =>
      measurePerf("prediction.rows.build", () => buildPredictionListRows(allMarkets), {
        marketCount: allMarkets.length,
      }),
    [allMarkets],
  );

  const visibleRows = useMemo(() => {
    return measurePerf("prediction.rows.filter-sort", () => {
      const filtered = filterPredictionMarkets(
        allRows,
        browseTab,
        effectiveVenueScope,
        categoryId,
        debouncedSearchQuery,
        watchlistSet,
      );
      return sortPredictionMarkets(
        filtered,
        sortPreference.columnId
          ? sortPreference
          : getDefaultPredictionSort(browseTab),
      );
    }, {
      browseTab,
      categoryId,
      rowCount: allRows.length,
      search: debouncedSearchQuery.trim(),
      sortColumnId: sortPreference.columnId,
      sortDirection: sortPreference.direction,
      venueScope: effectiveVenueScope,
    });
  }, [
    allRows,
    browseTab,
    categoryId,
    debouncedSearchQuery,
    effectiveVenueScope,
    sortPreference,
    watchlistSet,
  ]);

  const visibleRowLookup = useMemo(
    () => buildPredictionVisibleRowLookup(visibleRows),
    [visibleRows],
  );

  const selectedRowState = useMemo(
    () => resolvePredictionSelectedRowState(selectedRowKey, visibleRowLookup),
    [selectedRowKey, visibleRowLookup],
  );
  const selectedRow = selectedRowState.row;
  const selectedSummary = useMemo(
    () =>
      resolvePredictionSelectedSummary({
        detailOpen,
        selectedDetailMarketKey,
        selectedRow,
      }),
    [detailOpen, selectedDetailMarketKey, selectedRow],
  );
  const selectedSummaryKey = selectedSummary?.key ?? null;
  const selectedIndex = selectedRowState.index;
  const sortedOutcomeMarkets = useMemo(
    () =>
      selectedRow?.kind === "group"
        ? sortPredictionOutcomeMarkets(selectedRow.markets)
        : [],
    [selectedRow],
  );
  const {
    detail,
    detailError,
    detailLoadCount,
    lastRefreshAt,
    transportState,
    actions: detailActions,
  } = usePredictionDetailData({
    focused,
    historyRange,
    selectedSummary,
    setCatalogCache,
  });

  return {
    catalogHasMore,
    catalogLoadCount,
    catalogLoadingMore,
    catalogStatus,
    debouncedSearchQuery,
    detail,
    detailError,
    detailLoadCount,
    lastRefreshAt,
    loadMoreCatalog,
    selectedIndex,
    selectedRow,
    selectedSummary,
    selectedSummaryKey,
    sortedOutcomeMarkets,
    transportState,
    visibleRows,
    actions: {
      setNextDetailLoadDelay: detailActions.setNextDetailLoadDelay,
    },
  };
}
