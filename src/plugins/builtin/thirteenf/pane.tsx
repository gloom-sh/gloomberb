import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  DataTableView,
  EmptyState, KeyValueRow, PaneStatusBody, QueryBar, Tabs, usePaneHeaderTabs, usePaneNoticeFooter, useTableLoadMore, type DataTableKeyEvent,
  type DataTableRootKeyContext, type PaneFooterSegment
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import {
  Box,
  Text,
  useRendererHost,
  type InputRenderable,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useMineTickers } from "../shared/mine-tickers";
import { usePaneStatusFooter, usePaneStatusLinkFooter } from "../shared/pane-footer";
import { loadBrowserRows, loadFilingPositions, loadFundDetail } from "./data";
import { FundOverlapView } from "./overlap-pane";
import { ThirteenFCrowdingPane } from "./signals-pane";
import { PaneFooterScope } from "../../../components/layout/pane/footer";
import {
  DEFAULT_BROWSER_SORT,
  DEFAULT_FILING_POSITION_SORT,
  DEFAULT_HOLDING_SORT,
  DEFAULT_TIMELINE_SORT,
  FUND_DETAIL_TABS,
  THIRTEENF_PANE_ID,
  hasComparable13FQuarter,
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
  renderBrowserCell,
  renderFilingPositionCell,
  renderHoldingCell,
  renderTimelineCell,
} from "./table";
import type {
  FilingPositionColumn,
  FilingPositionColumnId,
  FilingPositionRow,
  FundBrowserColumn,
  FundBrowserColumnId,
  FundBrowserRow,
  FundDetailData,
  FundHoldingColumn,
  FundHoldingColumnId,
  FundHoldingRow,
  FundSortPreference,
  FundTimelineColumn,
  FundTimelineColumnId,
  FundTimelineRow,
  LoadStatus,
  ThirteenFDetailTab,
  ThirteenFHoldingRecord,
} from "./types";

interface FundSeed {
  cik: string;
  name: string;
}

const trimSearchValue = (value: string) => value.trim();
const SEARCH_DEBOUNCE_MS = 250;
const LOAD_MORE_THRESHOLD = 10;
const THIRTEENF_TABS = [{ label: "Funds", value: "funds" }, { label: "Crowding", value: "crowding" }];

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

function ThirteenFBrowserPane({ focused, width, height, onDetailChange }: PaneProps & { onDetailChange: (open: boolean) => void }) {
  const [storedQuery] = usePaneSettingValue("query", "");
  const [initialCik] = usePaneSettingValue("initialCik", "");
  const normalizedQuery = String(storedQuery ?? "").trim();
  const [query, setQuery] = usePluginPaneState<string>("query", normalizedQuery);
  const [sortPreference, setSortPreference] = usePluginPaneState<FundSortPreference<FundBrowserColumnId>>(
    "sortPreference",
    DEFAULT_BROWSER_SORT,
  );
  const browserMode = useMemo(() => inferBrowserTabFromQuery(query), [query]);
  // Selection is pane state, so a reload or a shared layout keeps the row.
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
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
  useEffect(() => { onDetailChange(!!detailSeed); return () => onDetailChange(false); }, [detailSeed, onDetailChange]);
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
    // A new query starts from an empty list; a refresh keeps the rows it has.
    if (!refresh) setRows([]);
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
        if (result.warning) setWarning(current => [...new Set([current, result.warning].filter(Boolean))].join(" "));
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
  const columns = useMemo(() => {
    if (browserMode !== "performance") return buildBrowserColumns(width);
    const history = rows[0]?.priorReturns ?? [];
    return [...buildBrowserColumns(width - history.length * 10).filter(column => !["rows", "filed"].includes(column.id)), ...history.map((point, index) => ({ id: `return${index + 1}` as FundBrowserColumnId, label: point.quarter, width: 10, align: "right" as const }))];
  }, [width, browserMode, rows]);

  useEffect(() => {
    if (selectedId && sortedRows.some((row) => row.id === selectedId)) return;
    setSelectedId(sortedRows[0]?.id ?? null);
  }, [selectedId, setSelectedId, sortedRows]);

  const loadMoreFromScroll = useTableLoadMore(tableScrollRef, hasMore && !loadingMore && status === "loaded", loadMore, LOAD_MORE_THRESHOLD);

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
  // Every request behind a fund detail is cached per path, so warming it
  // while the cursor rests on the row makes Enter read from cache.
  const prefetchDetail = useCallback((row: FundBrowserRow) => {
    void loadFundDetail(row.cik, row.name).catch(() => {});
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
    <QueryBar
      width={width}
      search={{
        value: query,
        onChange: updateQuery,
        placeholder: "fund, ticker, CIK, or latest",
        focused: focused && !detailSeed,
        active: searchFocused,
        onActiveChange: (active) => active ? focusSearch() : blurSearch(),
        focusToken: searchFocusToken,
        inputRef: searchInputRef,
        debounceMs: SEARCH_DEBOUNCE_MS,
        onNavigateDown: blurSearch,
        normalizeValue: trimSearchValue,
      }}
    />
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
        prefetchDetail={prefetchDetail}
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
      />
    </Box>
  );
}

export function FundDetailView({
  focused,
  seed,
  width,
}: {
  focused: boolean;
  seed: FundSeed;
  width: number;
}) {
  const rendererHost = useRendererHost();
  const mine = useMineTickers();
  const [mineOnly, setMineOnly] = usePluginPaneState<boolean>("13f:mine", false);
  const { pinTicker } = usePluginTickerActions();
  const [storedTab, setStoredTab] = usePluginPaneState<ThirteenFDetailTab>("detailTab", "holdings");
  const activeTab: ThirteenFDetailTab = storedTab === "filings" || storedTab === "overlap" ? storedTab : "holdings";
  const [holdingSort, setHoldingSort] = usePluginPaneState<FundSortPreference<FundHoldingColumnId>>("holdingSort", DEFAULT_HOLDING_SORT);
  const [filingSort, setFilingSort] = usePluginPaneState<FundSortPreference<FundTimelineColumnId>>("filingSort", DEFAULT_TIMELINE_SORT);
  // Selections and the open filing are pane state, so a reload or a shared
  // layout comes back to the same rows.
  const [holdingSelectedId, setHoldingSelectedId] = usePluginPaneState<string | null>("holdingSelectedId", null);
  const [filingSelectedId, setFilingSelectedId] = usePluginPaneState<string | null>("filingSelectedId", null);
  const [openFilingId, setOpenFilingId] = usePluginPaneState<string | null>("openFilingId", null);
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
    sortHoldingRows(holdingRows.filter(row => !mineOnly || mine.has(row.ticker)).map(row => ({ ...row, mine: mine.has(row.ticker) })), holdingSort)
  ), [holdingRows, holdingSort, mineOnly, mine]);
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
    : selectedHoldingFiling?.url ?? latestForm?.url;
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
    if (!focused || event.targetEditable || activeTab === "overlap") return;
    if (isPlainKey(event, "r") && !openFiling) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return;
    }
    if (isPlainKey(event, "m") && activeTab === "holdings") {
      event.preventDefault?.(); event.stopPropagation?.(); setMineOnly(value => !value); return;
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

  usePaneNoticeFooter({
    registrationId: "thirteenf-holdings-notices",
    notices: data?.warnings ?? [],
    focused,
    enabled: !openFiling && activeTab !== "overlap",
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
    loading: activeTab !== "overlap" && status === "loading",
    error: activeTab === "overlap" ? null : error,
    info: activeTab === "overlap" ? [] : detailStatusInfo,
    showOpenHint: true,
    hints: activeTab === "holdings" ? [{ id: "mine", key: "m", label: mineOnly ? "all tickers" : "mine", onPress: () => setMineOnly(value => !value) }] : [],
  });

  if ((status === "loading" || status === "idle") && !data) {
    return (
      <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
        <PaneStatusBody loading align="center" loadingLabel="Loading 13F filing..." />
      </Box>
    );
  }

  if (status === "error" && !data) {
    return (
      <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
        <Box padding={1}>
          <EmptyState status={error ? "error" : "empty"} title="13F fund unavailable." message={error ?? "Failed to load fund."} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} flexGrow={1} overflow="hidden">
      {data?.name && data.name !== seed.name ? (
        <Box paddingX={1}><Text fg={colors.text}>{data.name}</Text></Box>
      ) : null}
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
      {activeTab === "overlap" && data ? <FundOverlapView data={data} focused={focused} width={width} /> : activeTab === "filings" ? (
        <DataTableStackView<FundTimelineRow, FundTimelineColumn>
          focused={focused}
          detailOpen={!!openFiling}
          onBack={closeOpenFiling}
          detailTitle={openFiling ? `${openFiling.periodOfReport} filing` : "13F filing"}
          detailContent={openFiling ? (
            <FilingDetailView focused={focused} filing={openFiling} width={width} sourceWarnings={data?.warnings ?? []} />
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
          rootBefore={(
            <Box flexDirection="column">
              <QueryBar width={width} filters={[{ id: "mine", kind: "toggle", label: "Mine", value: mineOnly, onChange: setMineOnly }]} />
              <Box flexDirection="column" paddingX={1}>
                <KeyValueRow label="Reported" value={data?.latestForm?.periodOfReport ?? "--"} detail={`Filed ${data?.latestForm?.filedAsOfDate || "--"}`} width={Math.max(1, width - 2)} />
                <KeyValueRow label="Compared with" value={data && hasComparable13FQuarter(data) ? data.previousForm!.periodOfReport : "Prior quarter unavailable"} width={Math.max(1, width - 2)} />
                {data?.latestReport && data.latestReport.filings.length > 1 ? (
                  <KeyValueRow label="Public report" value={`${data.latestReport.filings.length} filings combined`} width={Math.max(1, width - 2)} />
                ) : null}
              </Box>
            </Box>
          )}
          columns={[{ id: "mine", label: "MINE", width: 5, align: "left" }, ...buildHoldingColumns(width - 6)]}
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
          renderCell={(row, column, index, state) => column.id === "mine" ? { text: mine.has(row.ticker) ? "yes" : "", color: state.selected ? colors.selectedText : colors.positive } : renderHoldingCell(row, column, index, state)}
          emptyStateTitle="No 13F holdings."
        />
      )}
    </Box>
  );
}

function FilingDetailView({
  focused,
  filing,
  width,
  sourceWarnings,
}: {
  focused: boolean;
  filing: FundTimelineRow;
  width: number;
  sourceWarnings: string[];
}) {
  const { pinTicker } = usePluginTickerActions();
  const [sortPreference, setSortPreference] = usePluginPaneState<FundSortPreference<FilingPositionColumnId>>(
    "filingPositionSort",
    DEFAULT_FILING_POSITION_SORT,
  );
  const [selectedPositionId, setSelectedPositionId] = usePluginPaneState<string | null>("selectedPositionId", null);
  const [holdings, setHoldings] = useState<ThirteenFHoldingRecord[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const moreAbortRef = useRef<AbortController | null>(null);
  const positionScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const load = useCallback((refresh = false) => {
    abortRef.current?.abort();
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    setWarnings([]);
    // Another filing starts empty; a refresh keeps its positions on screen.
    if (!refresh) setHoldings([]);
    setHasMore(false);
    setNextOffset(0);
    void loadFilingPositions(filing.cik, filing.accessionNumber, controller.signal, { forceRefresh: refresh, offset: 0 })
      .then((result) => {
        if (abortRef.current !== controller) return;
        setHoldings(result.rows);
        setWarnings(result.warnings);
        setHasMore(result.hasMore);
        setNextOffset(result.rows.length);
        setStatus("loaded");
      })
      .catch((loadError) => {
        if (abortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [filing.accessionNumber, filing.cik]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || status !== "loaded") return;
    moreAbortRef.current?.abort();
    const controller = new AbortController();
    moreAbortRef.current = controller;
    setLoadingMore(true);
    void loadFilingPositions(filing.cik, filing.accessionNumber, controller.signal, { offset: nextOffset })
      .then((result) => {
        if (moreAbortRef.current !== controller) return;
        setHoldings((current) => [...current, ...result.rows]);
        setWarnings((current) => [...new Set([...current, ...result.warnings])]);
        setHasMore(result.hasMore);
        setNextOffset(nextOffset + result.rows.length);
      })
      .catch((loadError) => {
        if (moreAbortRef.current !== controller) return;
        if (loadError instanceof Error && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (moreAbortRef.current !== controller) return;
        setLoadingMore(false);
      });
  }, [filing.accessionNumber, filing.cik, hasMore, loadingMore, nextOffset, status]);

  const onBodyScrollActivity = useTableLoadMore(positionScrollRef, hasMore && !loadingMore && status === "loaded", loadMore);

  useEffect(() => {
    load(false);
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      moreAbortRef.current?.abort();
      moreAbortRef.current = null;
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

  usePaneNoticeFooter({ registrationId: "thirteenf-filing-notices", notices: [...new Set([...sourceWarnings, ...warnings])], focused });

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
        scrollRef={positionScrollRef}
        onBodyScrollActivity={onBodyScrollActivity}
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
      />
    </Box>
  );
}

export function ThirteenFPane(props: PaneProps) {
  const [tab, setTab] = usePluginPaneState<string>("browserTab", "funds");
  const [detailOpen, setDetailOpen] = useState(false);
  const tabsInHeader = usePaneHeaderTabs({ tabs: THIRTEENF_TABS, activeValue: tab, onSelect: setTab, focused: props.focused && !detailOpen });
  const tabRows = tabsInHeader ? 0 : 1;
  return <Box flexDirection="column" width={props.width} height={props.height}>
    {!tabsInHeader && <Tabs tabs={THIRTEENF_TABS} activeValue={tab} onSelect={setTab} focused={props.focused && !detailOpen} compact />}
    <PaneFooterScope active>
      {tab === "crowding" ? <ThirteenFCrowdingPane {...props} height={Math.max(1, props.height - tabRows)} /> : <ThirteenFBrowserPane {...props} onDetailChange={setDetailOpen} height={Math.max(1, props.height - tabRows)} />}
    </PaneFooterScope>
  </Box>;
}
