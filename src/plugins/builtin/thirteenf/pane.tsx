import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Text,
  type InputRenderable,
  type ScrollBoxRenderable,
  useRendererHost,
} from "../../../ui";
import {
  DataTableStackView,
  DataTableView,
  EmptyState,
  InputSearchBar,
  Spinner,
  Tabs,
  type PaneFooterSegment,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { loadBrowserRows, loadFilingPositions, loadFundDetail } from "./data";
import {
  DEFAULT_BROWSER_SORT,
  DEFAULT_FILING_POSITION_SORT,
  DEFAULT_HOLDING_SORT,
  DEFAULT_TIMELINE_SORT,
  FUND_DETAIL_TABS,
  THIRTEENF_PANE_ID,
  buildBrowserColumns,
  buildFilingPositionColumns,
  buildFilingPositionRows,
  buildFundHoldingRows,
  buildHoldingColumns,
  buildTimelineColumns,
  buildTimelineRows,
  inferBrowserTabFromQuery,
  nextSortPreference,
  selectedIndexById,
  sortBrowserRows,
  sortFilingPositionRows,
  sortHoldingRows,
  sortTimelineRows,
} from "./model";
import {
  renderFilingPositionCell,
  renderBrowserCell,
  renderHoldingCell,
  renderTimelineCell,
} from "./table";
import type {
  FilingPositionColumn,
  FilingPositionColumnId,
  FilingPositionRow,
  FundBrowserColumnId,
  FundBrowserColumn,
  FundBrowserRow,
  FundDetailData,
  FundHoldingColumnId,
  FundHoldingColumn,
  FundHoldingRow,
  FundSortPreference,
  FundTimelineColumnId,
  FundTimelineColumn,
  FundTimelineRow,
  LoadStatus,
  ThirteenFDetailTab,
  ThirteenFHoldingRecord,
} from "./types";
import { usePaneStatusFooter, usePaneStatusLinkFooter } from "../shared/pane-footer";

interface FundSeed {
  cik: string;
  name: string;
}

const SEARCH_DEBOUNCE_MS = 250;
const LOAD_MORE_THRESHOLD = 10;
const trimSearchValue = (value: string) => value.trim();

function appendUniqueRows(currentRows: FundBrowserRow[], nextRows: FundBrowserRow[]): FundBrowserRow[] {
  if (nextRows.length === 0) return currentRows;
  const seen = new Set(currentRows.map((row) => row.id));
  const merged = [...currentRows];
  for (const row of nextRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

export function ThirteenFPane({ focused, width, height }: PaneProps) {
  const [storedQuery] = usePaneSettingValue("query", "");
  const [initialCik] = usePaneSettingValue("initialCik", "");
  const normalizedQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState<string>("query", normalizedQuery);
  const [sortPreference, setSortPreference] = usePluginPaneState<FundSortPreference<FundBrowserColumnId>>(
    "sortPreference",
    DEFAULT_BROWSER_SORT,
  );
  const browserMode = useMemo(() => inferBrowserTabFromQuery(query), [query]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<FundBrowserRow[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | undefined>();
  const [quarter, setQuarter] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailSeed, setDetailSeed] = useState<FundSeed | null>(() => (
    initialCik ? { cik: String(initialCik), name: normalizedQuery || String(initialCik) } : null
  ));
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchInputRef = useRef<InputRenderable | null>(null);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const didOpenInitialCikRef = useRef(false);

  const load = useCallback((refresh = false) => {
    abortRef.current?.abort();
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    setWarning(null);
    setHasMore(false);
    setNextOffset(0);
    setLoadingMore(false);
    void loadBrowserRows(browserMode, query, controller.signal, { forceRefresh: refresh })
      .then((result) => {
        if (abortRef.current !== controller) return;
        setRows(result.rows);
        setPeriod(result.period);
        setQuarter(result.quarter);
        setWarning(result.warning ?? null);
        setHasMore(result.hasMore === true);
        setNextOffset(result.nextOffset ?? result.rows.length);
        setStatus("loaded");
      })
      .catch((loadError) => {
        if (abortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setRows([]);
        setHasMore(false);
        setNextOffset(0);
        setStatus("error");
      });
  }, [browserMode, query]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || status !== "loaded") return;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    setLoadingMore(true);
    void loadBrowserRows(browserMode, query, controller.signal, { offset: nextOffset })
      .then((result) => {
        if (moreAbortRef.current !== controller) return;
        setRows((currentRows) => appendUniqueRows(currentRows, result.rows));
        if (result.period) setPeriod(result.period);
        if (result.quarter) setQuarter(result.quarter);
        setWarning(result.warning ?? null);
        setHasMore(result.hasMore === true);
        setNextOffset(result.nextOffset ?? nextOffset + result.rows.length);
      })
      .catch((loadError) => {
        if (moreAbortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setWarning(loadError instanceof Error ? loadError.message : "More 13F rows failed");
      })
      .finally(() => {
        if (moreAbortRef.current !== controller) return;
        setLoadingMore(false);
      });
  }, [browserMode, hasMore, loadingMore, nextOffset, query, status]);

  useEffect(() => {
    load(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      moreAbortRef.current?.abort();
      moreAbortRef.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!initialCik || didOpenInitialCikRef.current) return;
    didOpenInitialCikRef.current = true;
    setDetailSeed({ cik: String(initialCik), name: query || String(initialCik) });
  }, [initialCik, query]);

  useShortcut((event) => {
    if (!focused || detailSeed) return;
    if (searchFocused) {
      if (isPlainKey(event, "escape")) {
        event.stopPropagation?.();
        event.preventDefault?.();
        setSearchFocused(false);
      }
      return;
    }
    if (event.targetEditable) return;
    if (isPlainKey(event, "r")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      load(true);
      return;
    }
    if (isPlainKey(event, "/")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      setSearchFocused(true);
      setSearchFocusToken((current) => current + 1);
    }
  }, { allowEditable: true });

  const sortedRows = useMemo(() => sortBrowserRows(rows, sortPreference), [rows, sortPreference]);
  const columns = useMemo(() => buildBrowserColumns(width), [width]);

  useEffect(() => {
    if (selectedId && sortedRows.some((row) => row.id === selectedId)) return;
    setSelectedId(sortedRows[0]?.id ?? null);
  }, [selectedId, setSelectedId, sortedRows]);

  const loadMoreFromScroll = useCallback(() => {
    const scrollBox = tableScrollRef.current;
    if (!scrollBox?.viewport) return;
    const viewportHeight = Math.max(1, scrollBox.viewport.height);
    if (scrollBox.scrollTop + viewportHeight < scrollBox.scrollHeight - LOAD_MORE_THRESHOLD) return;
    loadMore();
  }, [loadMore]);

  const refresh = useCallback(() => load(true), [load]);
  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);

  const blurSearch = useCallback(() => {
    setSearchFocused(false);
  }, []);

  const updateQuery = useCallback((nextQuery: string) => {
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    setSelectedId(null);
  }, [setQuery]);

  const openDetail = useCallback((row: FundBrowserRow) => {
    setSearchFocused(false);
    setDetailSeed({ cik: row.cik, name: row.name });
  }, []);

  const browserStatusInfo = useMemo<PaneFooterSegment[]>(() => [
        ...(loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
        ...(warning ? [{ id: "warning", parts: [{ text: warning, tone: "warning" as const }] }] : []),
  ], [loadingMore, warning]);
  usePaneStatusFooter({
    registrationId: THIRTEENF_PANE_ID,
    enabled: !detailSeed,
    loading: status === "loading",
    error,
    info: browserStatusInfo,
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusSearch },
    ],
  });

  const rootBefore = (
    <Box flexDirection="column">
      <InputSearchBar
        value={query}
        focused={focused && !detailSeed}
        active={searchFocused}
        width={width}
        focusToken={searchFocusToken}
        inputRef={searchInputRef}
        placeholder="fund, ticker, CIK, or latest"
        debounceMs={SEARCH_DEBOUNCE_MS}
        normalizeValue={trimSearchValue}
        onFocus={focusSearch}
        onBlur={blurSearch}
        onNavigateDown={blurSearch}
        onQueryChange={updateQuery}
      />
    </Box>
  );

  const emptyTitle = status === "loading" || status === "idle"
    ? "Loading 13F funds..."
    : error ?? warning ?? "No 13F funds found.";

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    if (event.name === "/") {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch, refresh]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <DataTableStackView<FundBrowserRow, FundBrowserColumn>
        focused={focused && (!searchFocused || !!detailSeed)}
        detailOpen={!!detailSeed}
        onBack={() => setDetailSeed(null)}
        detailTitle={detailSeed?.name}
        detailContent={detailSeed ? (
          <FundDetailView
            focused={focused}
            seed={detailSeed}
            width={width}
          />
        ) : (
          <Box flexGrow={1} />
        )}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedId(id),
        }}
        onActivate={openDetail}
        onRootKeyDown={handleRootKeyDown}
        rootWidth={width}
        rootBefore={rootBefore}
        scrollRef={tableScrollRef}
        onBodyScrollActivity={loadMoreFromScroll}
        resetScrollKey={`${browserMode}:${query}`}
        columns={columns}
        items={sortedRows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => {
          setSortPreference((current) => nextSortPreference(
            current,
            columnId as FundBrowserColumnId,
            columnId === "fund" || columnId === "cik" ? "asc" : "desc",
          ));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderBrowserCell}
        emptyStateTitle={emptyTitle}
        showHorizontalScrollbar={false}
      />
    </Box>
  );
}

function FundDetailView({
  focused,
  seed,
  width,
}: {
  focused: boolean;
  seed: FundSeed;
  width: number;
}) {
  const rendererHost = useRendererHost();
  const { pinTicker } = usePluginTickerActions();
  const [storedTab, setStoredTab] = usePluginPaneState<ThirteenFDetailTab>("detailTab", "holdings");
  const activeTab: ThirteenFDetailTab = storedTab === "filings" ? "filings" : "holdings";
  const [holdingSort, setHoldingSort] = usePluginPaneState<FundSortPreference<FundHoldingColumnId>>("holdingSort", DEFAULT_HOLDING_SORT);
  const [filingSort, setFilingSort] = usePluginPaneState<FundSortPreference<FundTimelineColumnId>>("filingSort", DEFAULT_TIMELINE_SORT);
  const [holdingSelectedId, setHoldingSelectedId] = useState<string | null>(null);
  const [filingSelectedId, setFilingSelectedId] = useState<string | null>(null);
  const [openFilingId, setOpenFilingId] = useState<string | null>(null);
  const [filingReturnTab, setFilingReturnTab] = useState<ThirteenFDetailTab | null>(null);
  const [data, setData] = useState<FundDetailData | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback((refresh = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    void loadFundDetail(seed.cik, seed.name, controller.signal, { forceRefresh: refresh })
      .then((nextData) => {
        if (abortRef.current !== controller) return;
        setData(nextData);
        setStatus("loaded");
      })
      .catch((loadError) => {
        if (abortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [seed.cik, seed.name]);

  useEffect(() => {
    load(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const holdingRows = useMemo(() => buildFundHoldingRows(data), [data]);
  const visibleHoldingRows = useMemo(() => (
    sortHoldingRows(holdingRows.filter((row) => row.value != null), holdingSort)
  ), [holdingRows, holdingSort]);
  const filingRows = useMemo(() => sortTimelineRows(buildTimelineRows(data?.forms ?? []), filingSort), [data?.forms, filingSort]);
  const selectedHoldingIndex = selectedIndexById(visibleHoldingRows, holdingSelectedId);
  const selectedFilingIndex = selectedIndexById(filingRows, filingSelectedId);
  const selectedHolding = activeTab === "holdings" ? visibleHoldingRows[selectedHoldingIndex] ?? null : null;
  const selectedFiling = filingRows[selectedFilingIndex] ?? null;
  const openFiling = openFilingId
    ? filingRows.find((row) => row.id === openFilingId) ?? null
    : null;
  const latestForm = data?.latestForm ?? null;
  const selectedHoldingFiling = selectedHolding?.accessionNumber
    ? filingRows.find((row) => row.id === selectedHolding.accessionNumber) ?? null
    : latestForm
      ? filingRows.find((row) => row.id === latestForm.accessionNumber) ?? null
      : null;
  const filingTarget = openFiling
    ? null
    : activeTab === "holdings"
      ? selectedHoldingFiling
      : selectedFiling;
  const currentSourceUrl = activeTab === "filings"
    ? openFiling?.url ?? selectedFiling?.url
    : latestForm?.url;
  const statusFiling = openFiling ?? latestForm;
  useEffect(() => {
    if (holdingSelectedId && visibleHoldingRows.some((row) => row.id === holdingSelectedId)) return;
    setHoldingSelectedId(visibleHoldingRows[0]?.id ?? null);
  }, [holdingSelectedId, visibleHoldingRows]);

  useEffect(() => {
    if (filingSelectedId && filingRows.some((row) => row.id === filingSelectedId)) return;
    setFilingSelectedId(filingRows[0]?.id ?? null);
  }, [filingRows, filingSelectedId]);

  useEffect(() => {
    if (!openFilingId) return;
    if (filingRows.some((row) => row.id === openFilingId)) return;
    setOpenFilingId(null);
  }, [filingRows, openFilingId]);

  const refresh = useCallback(() => load(true), [load]);
  const openTicker = useCallback(() => {
    if (selectedHolding?.ticker) pinTicker(selectedHolding.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker, selectedHolding?.ticker]);
  const closeOpenFiling = useCallback(() => {
    setOpenFilingId(null);
    if (filingReturnTab) {
      setStoredTab(filingReturnTab);
      setFilingReturnTab(null);
    }
  }, [filingReturnTab, setStoredTab]);
  const openFilingInPane = useCallback((row: FundTimelineRow | null, returnTab: ThirteenFDetailTab | null = null) => {
    if (!row) return;
    setFilingSelectedId(row.id);
    setFilingReturnTab(returnTab);
    setOpenFilingId(row.id);
    setStoredTab("filings");
  }, [setStoredTab]);
  const openSelectedFilingInPane = useCallback(() => {
    openFilingInPane(filingTarget, activeTab === "holdings" ? "holdings" : null);
  }, [activeTab, filingTarget, openFilingInPane]);

  const selectDetailTab = useCallback((tab: string) => {
    setStoredTab(tab as ThirteenFDetailTab);
    setOpenFilingId(null);
    setFilingReturnTab(null);
  }, [setStoredTab]);

  useShortcut((event) => {
    if (!focused || !openFiling || event.targetEditable) return;
    if (!isDetailBackNavigationKey(event)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    closeOpenFiling();
  }, { phase: "before" });

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped) return;
    if (!focused || event.targetEditable) return;
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return;
    }
    if (isPlainKey(event, "f") && filingTarget) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedFilingInPane();
      return;
    }
    if (isPlainKey(event, "t") && selectedHolding?.ticker) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openTicker();
    }
  });

  const detailStatusInfo = useMemo<PaneFooterSegment[]>(() => (
    statusFiling?.isAmendment
      ? [{ id: "amended", parts: [{ text: "amended", tone: "warning" }] }]
      : []
  ), [statusFiling?.isAmendment]);
  usePaneStatusLinkFooter({
    registrationId: "thirteenf-detail",
    focused,
    url: openFiling ? currentSourceUrl : null,
    source: openFiling ? "SEC 13F" : null,
    loading: status === "loading",
    error,
    info: detailStatusInfo,
    showOpenHint: true,
  });

  if ((status === "loading" || status === "idle") && !data) {
    return (
      <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading 13F filing..." />
        </Box>
      </Box>
    );
  }

  if (status === "error" && !data) {
    return (
      <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
        <Box padding={1}>
          <EmptyState title="13F fund unavailable." message={error ?? "Failed to load fund."} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
      <Box height={1}>
        <Tabs
          tabs={FUND_DETAIL_TABS}
          activeValue={activeTab}
          onSelect={selectDetailTab}
          compact
          variant="pill"
          focused={focused}
        />
      </Box>
      {activeTab === "filings" ? (
        <DataTableStackView<FundTimelineRow, FundTimelineColumn>
          focused={focused}
          detailOpen={!!openFiling}
          onBack={closeOpenFiling}
          detailTitle={openFiling ? `${openFiling.periodOfReport} filing` : "13F filing"}
          detailContent={openFiling ? (
            <FilingDetailView focused={focused} filing={openFiling} width={width} />
          ) : (
            <Box flexGrow={1} />
          )}
          selection={{
            kind: "id",
            selectedId: filingSelectedId,
            getId: (row) => row.id,
            onChange: (id) => setFilingSelectedId(id),
          }}
          onActivate={(row) => openFilingInPane(row)}
          onDetailKeyDown={(event) => {
            if (event.name !== "o" || !openFiling?.url) return false;
            event.preventDefault?.();
            event.stopPropagation?.();
            void rendererHost.openExternal(openFiling.url);
            return true;
          }}
          rootWidth={width}
          columns={buildTimelineColumns(width)}
          items={filingRows}
          sortColumnId={filingSort.columnId}
          sortDirection={filingSort.direction}
          onHeaderClick={(columnId) => setFilingSort((current) => nextSortPreference(
            current,
            columnId as FundTimelineColumnId,
            columnId === "period" || columnId === "filed" ? "desc" : "desc",
          ))}
          getItemKey={(row) => row.id}
          renderCell={renderTimelineCell}
          emptyStateTitle="No 13F filings."
          showHorizontalScrollbar={false}
        />
      ) : (
        <DataTableView<FundHoldingRow, FundHoldingColumn>
          focused={focused}
          selection={{
            kind: "id",
            selectedId: holdingSelectedId,
            getId: (row) => row.id,
            onChange: (id) => setHoldingSelectedId(id),
          }}
          rootWidth={width}
          columns={buildHoldingColumns(width)}
          items={visibleHoldingRows}
          sortColumnId={holdingSort.columnId}
          sortDirection={holdingSort.direction}
          onHeaderClick={(columnId) => {
            setHoldingSort((current) => nextSortPreference(
              current,
              columnId as FundHoldingColumnId,
              columnId === "ticker" || columnId === "type" || columnId === "issuer" || columnId === "action" ? "asc" : "desc",
            ));
          }}
          getItemKey={(row) => row.id}
          onActivate={(row) => {
            if (row.ticker) pinTicker(row.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
          }}
          renderCell={renderHoldingCell}
          emptyStateTitle="No 13F holdings."
          showHorizontalScrollbar={false}
        />
      )}
    </Box>
  );
}

function FilingDetailView({
  focused,
  filing,
  width,
}: {
  focused: boolean;
  filing: FundTimelineRow;
  width: number;
}) {
  const { pinTicker } = usePluginTickerActions();
  const [sortPreference, setSortPreference] = usePluginPaneState<FundSortPreference<FilingPositionColumnId>>(
    "filingPositionSort",
    DEFAULT_FILING_POSITION_SORT,
  );
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<ThirteenFHoldingRecord[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback((refresh = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    setHoldings([]);
    void loadFilingPositions(filing.cik, filing.accessionNumber, controller.signal, { forceRefresh: refresh })
      .then((nextHoldings) => {
        if (abortRef.current !== controller) return;
        setHoldings(nextHoldings);
        setStatus("loaded");
      })
      .catch((loadError) => {
        if (abortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [filing.accessionNumber, filing.cik]);

  useEffect(() => {
    load(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [load]);

  const positionRows = useMemo(() => (
    sortFilingPositionRows(
      buildFilingPositionRows(holdings, filing.tableValueTotal),
      sortPreference,
    )
  ), [filing.tableValueTotal, holdings, sortPreference]);
  const columns = useMemo(() => buildFilingPositionColumns(width), [width]);

  useEffect(() => {
    if (selectedPositionId && positionRows.some((row) => row.id === selectedPositionId)) return;
    setSelectedPositionId(positionRows[0]?.id ?? null);
  }, [positionRows, selectedPositionId]);

  const refresh = useCallback(() => load(true), [load]);
  const openPositionTicker = useCallback((row: FilingPositionRow | null | undefined) => {
    if (!row?.ticker) return;
    pinTicker(row.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const handlePositionKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "r") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    refresh();
    return true;
  }, [refresh]);

  const summaryRows = [
    ["Filer", filing.companyName || "--"],
    ["CIK", filing.cik],
    ["Filed", filing.filedAsOfDate || "--"],
    ["Form", filing.submissionType || "--"],
    ...(filing.isAmendment ? [["Amendment", filing.amendmentType ?? "amended"]] : []),
    ["Accession", filing.accessionNumber],
    ["Source", filing.url ? truncateWithEllipsis(filing.url, Math.max(12, width - 14)) : "--"],
  ];
  const summary = (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
      {summaryRows.map(([label, value]) => (
        <Box key={label} height={1} flexDirection="row">
          <Box width={12}>
            <Text fg={colors.textDim}>{label}</Text>
          </Box>
          <Text fg={colors.text}>{value}</Text>
        </Box>
      ))}
    </Box>
  );
  const emptyTitle = status === "loading" || status === "idle"
    ? "Loading filing positions..."
    : error ?? "No positions in filing.";

  return (
    <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
      <DataTableView<FilingPositionRow, FilingPositionColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedPositionId,
          getId: (row) => row.id,
          onChange: (id) => setSelectedPositionId(id),
        }}
        onActivate={openPositionTicker}
        onRootKeyDown={handlePositionKeyDown}
        rootWidth={width}
        rootBefore={summary}
        resetScrollKey={filing.accessionNumber}
        columns={columns}
        items={positionRows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => {
          setSortPreference((current) => nextSortPreference(
            current,
            columnId as FilingPositionColumnId,
            columnId === "ticker" || columnId === "type" || columnId === "issuer" || columnId === "cusip" || columnId === "discretion" ? "asc" : "desc",
          ));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderFilingPositionCell}
        emptyStateTitle={emptyTitle}
        showHorizontalScrollbar={false}
      />
    </Box>
  );
}
