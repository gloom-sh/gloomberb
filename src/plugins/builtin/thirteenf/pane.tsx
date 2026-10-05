import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  DataTableView,
  EmptyState, PaneStatusBody, QueryBar, StatGrid, usePagedRows, usePaneNoticeFooter, usePaneTabs, useQueryBarSearch, useTableLoadMore, type DataTableKeyEvent,
  type DataTableRootKeyContext, type PageRequest, type PaneFooterSegment, type PaneHint, type StatItem
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import {
  Box,
  useRendererHost,
  type ScrollBoxRenderable,
} from "../../../ui";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useMineTickers } from "../shared/mine-tickers";
import { usePaneStatusFooter, usePaneStatusLinkFooter } from "../../../components/layout/pane/status-footer";
import { loadBrowserRows, loadFilingPositions, loadFundDetail } from "./data";
import { FundOverlapView } from "./overlap-pane";
import { ThirteenFCrowdingPane, ThirteenFTickerHoldingsView } from "./signals-pane";
import { PaneFooterScope } from "../../../components/layout/pane/footer";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useClaimResearchTabKeys } from "../ticker-detail/research-tab-keys";
import {
  DEFAULT_BROWSER_SORT,
  DEFAULT_FILING_POSITION_SORT,
  DEFAULT_HOLDING_SORT,
  DEFAULT_TIMELINE_SORT,
  FUND_DETAIL_TABS,
  THIRTEENF_PANE_ID,
  amendmentKind,
  hasComparable13FQuarter,
  browserSortFor,
  buildBrowserColumns,
  buildFilingPositionColumns,
  buildFilingPositionRows,
  buildFundHoldingRows,
  buildHoldingColumns,
  buildTimelineColumns,
  buildTimelineRows,
  inferBrowserTabFromQuery,
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
} from "./types";

interface FundSeed {
  cik: string;
  name: string;
}

const trimSearchValue = (value: string) => value.trim();
const SEARCH_DEBOUNCE_MS = 250;
const LOAD_MORE_THRESHOLD = 10;
const THIRTEENF_TABS = [{ label: "Funds", value: "funds" }, { label: "Crowding", value: "crowding" }];

const rowId = (row: { id: string }) => row.id;

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
  // A ticker query lists its holders with their positions, as `fn 13F` does. A
  // ticker the positions lookup cannot resolve falls back to the holders' books.
  const [tickerFallbackQuery, setTickerFallbackQuery] = useState<string | null>(null);
  const showTickerHoldings = browserMode === "byTicker" && tickerFallbackQuery !== query;
  // Selection is pane state, so a reload or a shared layout keeps the row.
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedId", null);
  const loadPage = useCallback(({ offset, signal, force }: PageRequest) => (
    loadBrowserRows(browserMode, query, signal, offset > 0 ? { offset } : { forceRefresh: force })
  ), [browserMode, query]);
  // A new query starts from an empty list; a refresh keeps the rows it has.
  const browser = usePagedRows(showTickerHoldings ? null : loadPage, { getId: rowId });
  const { loading, loadingMore, rows } = browser;
  const error = browser.error?.message ?? null;
  // A refresh clears the pages' warnings until it answers.
  const pagesSettled = !loading && !browser.error;
  const warning = useMemo(() => {
    const notes = [...(pagesSettled ? browser.pages.map((page) => page.warning) : []), browser.moreError?.message];
    return [...new Set(notes.filter(Boolean))].join(" ") || null;
  }, [browser.moreError, browser.pages, pagesSettled]);
  const [detailSeed, setDetailSeed] = useState<FundSeed | null>(() => (
    initialCik ? { cik: String(initialCik), name: normalizedQuery || String(initialCik) } : null
  ));
  useEffect(() => { onDetailChange(!!detailSeed); return () => onDetailChange(false); }, [detailSeed, onDetailChange]);
  // A ticker query opens its funds inside the holders view, not through detailSeed.
  const [tickerFundOpen, setTickerFundOpen] = useState(false);
  const handleTickerDetailChange = useCallback((open: boolean) => {
    setTickerFundOpen(open);
    onDetailChange(open);
  }, [onDetailChange]);
  const detailOpen = !!detailSeed || tickerFundOpen;
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const didOpenInitialCikRef = useRef(false);

  useEffect(() => {
    if (!initialCik || didOpenInitialCikRef.current) return;
    didOpenInitialCikRef.current = true;
    setDetailSeed({ cik: String(initialCik), name: query || String(initialCik) });
  }, [initialCik, query]);

  useShortcut((event) => {
    if (!focused || detailOpen) return;
    if (searchFocused) {
      if (isPlainKey(event, "escape")) {
        event.stopPropagation?.();
        event.preventDefault?.();
        blurSearch();
      }
      return;
    }
    if (event.targetEditable) return;
    // The ticker holdings view refreshes itself.
    if (!showTickerHoldings) handleRefreshKey(event, browser.reload, { stopPropagation: true });
  }, { allowEditable: true });

  const browserSort = useMemo(() => browserSortFor(sortPreference, browserMode), [sortPreference, browserMode]);
  const sortedRows = useMemo(() => sortBrowserRows(rows, browserSort), [rows, browserSort]);
  const columns = useMemo(() => {
    if (browserMode !== "performance") return buildBrowserColumns(false);
    const history = rows[0]?.priorReturns ?? [];
    return [...buildBrowserColumns().filter(column => !["rows", "filed"].includes(column.id)), ...history.map((point, index) => ({ id: `return${index + 1}` as FundBrowserColumnId, label: point.quarter, width: 10, align: "right" as const }))];
  }, [browserMode, rows]);

  useEffect(() => {
    if (selectedId && sortedRows.some((row) => row.id === selectedId)) return;
    setSelectedId(sortedRows[0]?.id ?? null);
  }, [selectedId, setSelectedId, sortedRows]);

  const loadMoreFromScroll = useTableLoadMore(tableScrollRef, browser.hasMore, browser.loadMore, LOAD_MORE_THRESHOLD);

  const refresh = browser.reload;
  const updateQuery = useCallback((nextQuery: string) => {
    const trimmed = nextQuery.trim();
    setQuery(trimmed);
    setSelectedId(null);
  }, [setQuery]);

  const openDetail = useCallback((row: FundBrowserRow) => {
    blurSearch();
    setDetailSeed({ cik: row.cik, name: row.name });
  }, [blurSearch]);
  // Every request behind a fund detail is cached per path, so warming it
  // while the cursor rests on the row makes Enter read from cache.
  const prefetchDetail = useCallback((row: FundBrowserRow) => {
    void loadFundDetail(row.cik, row.name).catch(() => {});
  }, []);

  const browserStatusInfo = useMemo<PaneFooterSegment[]>(() => [
        ...(loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
        ...(warning ? [{ id: "warning", parts: [{ text: warning, tone: "warning" as const }] }] : []),
  ], [loadingMore, warning]);
  const searchHints = useMemo(() => [{ id: "search", key: "/", label: "search", onPress: focusSearch }], [focusSearch]);
  usePaneStatusFooter({
    registrationId: THIRTEENF_PANE_ID,
    enabled: !detailSeed && !showTickerHoldings,
    loading,
    error,
    info: browserStatusInfo,
    hints: searchHints,
  });

  const renderQueryBar = (meta?: string) => (
    <QueryBar
      width={width}
      meta={meta}
      search={{
        value: query,
        onChange: updateQuery,
        placeholder: "fund, ticker, CIK, or latest",
        focused: focused && !detailOpen,
        ...searchProps,
        debounceMs: SEARCH_DEBOUNCE_MS,
        normalizeValue: trimSearchValue,
      }}
    />
  );
  const rootBefore = renderQueryBar();

  const emptyTitle = loading
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
    return handleRefreshKey(event, refresh, { stopPropagation: true });
  }, [focusSearch, refresh]);

  const handleTickerRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return false;
  }, [focusSearch]);

  if (showTickerHoldings) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <ThirteenFTickerHoldingsView
          symbol={query.replace(/^\$/, "").toUpperCase()}
          focused={focused && !searchFocused}
          width={width}
          height={height}
          queryBar={renderQueryBar}
          hints={searchHints}
          onRootKeyDown={handleTickerRootKeyDown}
          onUnavailable={() => setTickerFallbackQuery(query)}
          onDetailChange={handleTickerDetailChange}
        />
      </Box>
    );
  }

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
        sortColumnId={browserSort.columnId}
        sortDirection={browserSort.direction}
        onHeaderClick={(columnId) => {
          setSortPreference(nextHeaderSort(browserSort, columnId as FundBrowserColumnId, {
            firstDirection: columnId === "fund" || columnId === "cik" ? "asc" : "desc",
          }));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderBrowserCell}
        selectedTextOverridesCellColor
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
  // In the Research pane's 13F tab, h/l move between these sections while the
  // fund is open, as they do in the 13F pane.
  useClaimResearchTabKeys(focused);

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
    if (!focused || !data) return;
    const direction = isPlainKey(event, "h", "left") ? -1 : isPlainKey(event, "l", "right") ? 1 : 0;
    if (!direction) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const index = FUND_DETAIL_TABS.findIndex((entry) => entry.value === activeTab);
    const next = FUND_DETAIL_TABS[Math.max(0, Math.min(FUND_DETAIL_TABS.length - 1, index + direction))];
    if (next && next.value !== activeTab) selectDetailTab(next.value);
  });

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
    if (!openFiling && handleRefreshKey(event, refresh, { stopPropagation: true })) return;
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

  const holdingStats: StatItem[] = [
    { id: "reported", label: "Reported", value: data?.latestForm?.periodOfReport ?? "--",
      detail: `filed ${data?.latestForm?.filedAsOfDate || "--"}${data?.latestForm && amendmentKind(data.latestForm) === "restatement" ? ", restated" : ""}` },
    data && hasComparable13FQuarter(data)
      ? { id: "compared", label: "Compared with", value: data.previousForm!.periodOfReport }
      : { id: "compared", label: "Compared with", value: "No prior quarter", tone: "muted" },
    ...(data?.latestReport && data.latestReport.filings.length > 1
      ? [{ id: "combined", label: "Combined", value: `${data.latestReport.filings.length} filings` }]
      : []),
  ];

  usePaneNoticeFooter({
    registrationId: "thirteenf-holdings-notices",
    notices: data?.warnings ?? [],
    focused,
    enabled: !openFiling && activeTab !== "overlap",
  });

  // `f` opens the selected holding's own filing in the pane; Enter opens its ticker.
  // Mine is a query bar toggle, which also lists it in the pane menu.
  const hasHoldingFiling = activeTab === "holdings" && !!filingTarget;
  const detailHints = useMemo<PaneHint[]>(() => hasHoldingFiling
    ? [{ id: "filing", key: "f", label: "iling", title: "Open Filing", onPress: openSelectedFilingInPane }]
    : [], [hasHoldingFiling, openSelectedFilingInPane]);
  usePaneStatusLinkFooter({
    registrationId: "thirteenf-detail",
    focused,
    url: openFiling ? currentSourceUrl : null,
    source: openFiling ? "SEC 13F" : null,
    loading: activeTab !== "overlap" && status === "loading",
    error: activeTab === "overlap" ? null : error,
    showOpenHint: true,
    hints: detailHints,
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
      <QueryBar
        width={width}
        filters={[
          { id: "section", label: "Show", inline: true, value: activeTab, options: FUND_DETAIL_TABS, onChange: selectDetailTab },
          ...(activeTab === "holdings" ? [{ id: "mine", kind: "toggle" as const, label: "Mine", value: mineOnly, onChange: setMineOnly }] : []),
        ]}
        meta={data?.name && data.name !== seed.name ? data.name : undefined}
      />
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
            if (!isPlainKey(event, "o") || !openFiling?.url) return false;
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
          onHeaderClick={(columnId) => setFilingSort((current) => nextHeaderSort(current, columnId as FundTimelineColumnId, {
            firstDirection: "desc",
          }))}
          getItemKey={(row) => row.id}
          renderCell={renderTimelineCell}
          selectedTextOverridesCellColor
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
          rootBefore={<StatGrid items={holdingStats} width={width} />}
          columns={[{ id: "mine", label: "MINE", width: 5, align: "left" }, ...buildHoldingColumns()]}
          items={visibleHoldingRows}
          sortColumnId={holdingSort.columnId}
          sortDirection={holdingSort.direction}
          onHeaderClick={(columnId) => {
            setHoldingSort((current) => nextHeaderSort(current, columnId as FundHoldingColumnId, {
              firstDirection: columnId === "ticker" || columnId === "type" || columnId === "issuer" || columnId === "action" ? "asc" : "desc",
            }));
          }}
          getItemKey={(row) => row.id}
          onActivate={(row) => {
            if (row.ticker) pinTicker(row.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
          }}
          renderCell={(row, column, index, state) => column.id === "mine" ? { text: mine.has(row.ticker) ? "yes" : "", color: colors.positive } : renderHoldingCell(row, column, index, state)}
          selectedTextOverridesCellColor
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
  const positionScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadPage = useCallback(({ offset, signal, force }: PageRequest) => (
    loadFilingPositions(filing.cik, filing.accessionNumber, signal, offset > 0 ? { offset } : { forceRefresh: force, offset })
  ), [filing.accessionNumber, filing.cik]);
  // Another filing starts empty; a refresh keeps its positions on screen.
  const positions = usePagedRows(loadPage);
  const holdings = positions.rows;
  const error = (positions.error ?? positions.moreError)?.message ?? null;
  // A refresh clears the pages' warnings until it answers.
  const pagesSettled = !positions.loading && !positions.error;
  const warnings = useMemo(() => (
    pagesSettled ? [...new Set(positions.pages.flatMap((page) => page.warnings))] : []
  ), [pagesSettled, positions.pages]);
  const onBodyScrollActivity = useTableLoadMore(positionScrollRef, positions.hasMore, positions.loadMore);

  const positionRows = useMemo(() => (
    sortFilingPositionRows(
      buildFilingPositionRows(holdings, filing.tableValueTotal),
      sortPreference,
    )
  ), [filing.tableValueTotal, holdings, sortPreference]);
  const columns = useMemo(() => buildFilingPositionColumns(), []);

  useEffect(() => {
    if (selectedPositionId && positionRows.some((row) => row.id === selectedPositionId)) return;
    setSelectedPositionId(positionRows[0]?.id ?? null);
  }, [positionRows, selectedPositionId]);

  const refresh = positions.reload;
  const openPositionTicker = useCallback((row: FilingPositionRow | null | undefined) => {
    if (!row?.ticker) return;
    pinTicker(row.ticker, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const handlePositionKeyDown = useCallback(
    (event: DataTableKeyEvent) => handleRefreshKey(event, refresh, { stopPropagation: true }),
    [refresh],
  );

  usePaneNoticeFooter({ registrationId: "thirteenf-filing-notices", notices: [...new Set([...sourceWarnings, ...warnings])], focused });

  // An untyped amendment may replace or add to the report, so only it is a caveat.
  const kind = amendmentKind(filing);
  const amendmentStat: StatItem | null = kind && {
    id: "amendment",
    label: "Amendment",
    value: kind === "restatement" ? "Restatement" : kind === "new-holdings" ? "New holdings" : "Unknown type",
    tone: kind === "unknown" ? "warning" : undefined,
  };
  // The fund names the stack and `o` opens the filing, so neither repeats here.
  const summaryItems: StatItem[] = [
    { id: "filed", label: "Filed", value: filing.filedAsOfDate || "--" },
    { id: "form", label: "Form", value: filing.submissionType || "--" },
    ...(amendmentStat ? [amendmentStat] : []),
    { id: "cik", label: "CIK", value: filing.cik },
    { id: "accession", label: "Accession", value: filing.accessionNumber },
  ];
  const summary = <StatGrid items={summaryItems} width={width} />;
  const emptyTitle = positions.loading
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
          setSortPreference((current) => nextHeaderSort(current, columnId as FilingPositionColumnId, {
            firstDirection: columnId === "ticker" || columnId === "type" || columnId === "issuer" || columnId === "cusip" || columnId === "discretion" ? "asc" : "desc",
          }));
        }}
        getItemKey={(row) => row.id}
        renderCell={renderFilingPositionCell}
        selectedTextOverridesCellColor
        emptyStateTitle={emptyTitle}
      />
    </Box>
  );
}

export function ThirteenFPane(props: PaneProps) {
  const [tab, setTab] = usePluginPaneState<string>("browserTab", "funds");
  const [detailOpen, setDetailOpen] = useState(false);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: THIRTEENF_TABS, activeValue: tab, onSelect: setTab, focused: props.focused && !detailOpen, compact: true });
  return <Box flexDirection="column" width={props.width} height={props.height}>
    {tabStrip}
    <PaneFooterScope active>
      {tab === "crowding" ? <ThirteenFCrowdingPane {...props} height={Math.max(1, props.height - tabRows)} /> : <ThirteenFBrowserPane {...props} onDetailChange={setDetailOpen} height={Math.max(1, props.height - tabRows)} />}
    </PaneFooterScope>
  </Box>;
}
