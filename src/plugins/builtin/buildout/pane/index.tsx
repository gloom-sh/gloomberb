import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, type ScrollBoxRenderable, useRendererHost } from "../../../../ui";
import {
  DataTableStackView,
  EmptyState,
  PageStackView,
  Spinner,
  useTableLoadMore,
  usePaneFooter,
  type DataTableKeyEvent,
  type PaneHint,
} from "../../../../components";
import type { PaneProps } from "../../../../types/plugin";
import { useShortcut } from "../../../../react/input";
import { usePaneStateValue } from "../../../../state/app/context";
import { useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { BuildoutDetail } from "../detail";
import type {
  BuildoutColumn,
  BuildoutColumnId,
  BuildoutList,
  BuildoutRow,
  BuildoutTabId,
  SortDirection,
} from "../model/types";
import {
  BUILDOUT_NAME,
  LOAD_MORE_THRESHOLD,
  buildoutApi,
} from "../model";
import { renderBuildoutCell } from "../cells";
import {
  activeRows,
  applyFavoriteToState,
  columnsForTab,
  defaultSortDirection,
  favoriteApiPath,
  favoriteKey,
  rowKey,
  rowStarred,
  rowTickerSymbols,
  rowTitle,
  rowWithFavorite,
  sortRows,
} from "../table-model";
import {
  tickerSearchText,
  tickerSymbol,
} from "../format";
import { BuildoutPaneHeader } from "./header";
import {
  activeBuildoutPage,
  renderBuildoutPageStatus,
  updateBuildoutFooterInfo,
} from "./status";
import { useBuildoutDataRuntime } from "../data-runtime";

const BUILDOUT_UPGRADE_URL = "https://thebuildout.ai/pricing";

export function BuildoutPane({ focused, width, height }: PaneProps) {
  const rendererHost = useRendererHost();
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const favoriteBusyKeysRef = useRef<Set<string>>(new Set());
  const [activeTab, setActiveTab] = usePaneStateValue<BuildoutTabId>("activeTab", "companies");
  const [selectedList, setSelectedList] = useState<BuildoutList | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailRow, setDetailRow] = useState<BuildoutRow | null>(null);
  const [sortColumnId, setSortColumnId] = useState<BuildoutColumnId | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [favoriteBusyKey, setFavoriteBusyKey] = useState<string | null>(null);
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null);

  const handleBeforeLoad = useCallback(() => {
    favoriteBusyKeysRef.current.clear();
    setDetailRow(null);
    setSelectedList(null);
    setUpgradeMessage(null);
    setFavoriteMessage(null);
    setFavoriteBusyKey(null);
  }, []);
  const {
    loadCompanies,
    loadIntel,
    loadSites,
    refresh,
    resetCompanies,
    setState,
    state,
  } = useBuildoutDataRuntime({
    activeTab,
    onBeforeLoad: handleBeforeLoad,
    selectedList,
  });
  const favoriteToken = state.status === "ready" ? state.token : null;
  const canFavorite = favoriteToken != null;

  const startUpgrade = useCallback(() => {
    if (upgradeBusy) return;
    setUpgradeBusy(true);
    setUpgradeMessage(null);
    void rendererHost.openExternal(BUILDOUT_UPGRADE_URL)
      .catch((error) => {
        setUpgradeMessage(error instanceof Error ? error.message : "upgrade page failed");
      })
      .finally(() => {
        setUpgradeBusy(false);
      });
  }, [rendererHost, upgradeBusy]);

  useShortcut((event) => {
    const key = (event.name ?? event.key ?? "").toLowerCase();
    if (!focused || key !== "u" || state.status !== "ready" || state.access === "pro") return;
    event.preventDefault();
    event.stopPropagation();
    startUpgrade();
  }, { scope: "buildout-upgrade" });

  useEffect(() => {
    setSelectedIndex(0);
    setDetailRow(null);
    setFavoriteMessage(null);
    const nextColumn: BuildoutColumnId | null = activeTab === "companies"
      ? selectedList ? "marketCap" : null
      : activeTab === "sites" ? "capture" : "time";
    setSortColumnId(nextColumn);
    setSortDirection(defaultSortDirection(nextColumn));
  }, [activeTab, selectedList?.slug]);

  const rows = useMemo(
    () => sortRows(activeRows(state, activeTab, selectedList), sortColumnId, sortDirection),
    [activeTab, selectedList, sortColumnId, sortDirection, state],
  );
  const columns = useMemo(() => columnsForTab(activeTab, selectedList, canFavorite), [activeTab, canFavorite, selectedList]);
  const selectedRow = rows[selectedIndex] ?? rows[0] ?? null;
  const tickerTexts = useMemo(() => {
    const symbols = new Set<string>();
    for (const row of rows) {
      for (const symbol of rowTickerSymbols(row)) symbols.add(symbol);
    }
    if (detailRow) {
      for (const symbol of rowTickerSymbols(detailRow)) symbols.add(symbol);
    }
    return [tickerSearchText([...symbols])];
  }, [detailRow, rows]);
  const { catalog: tickerCatalog, openTicker } = useInlineTickers(tickerTexts);
  const detailCompanyTicker = detailRow?.kind === "company" ? tickerSymbol(detailRow.item.ticker) : null;
  const openDetailTicker = useCallback(() => {
    if (!detailCompanyTicker) return;
    openTicker(detailCompanyTicker);
  }, [detailCompanyTicker, openTicker]);
  const footerHints = useMemo<PaneHint[]>(() => {
    const hints: PaneHint[] = [];
    if (state.status === "ready" && state.access !== "pro") {
      hints.push({ id: "upgrade", key: "u", label: "pgrade", onPress: startUpgrade });
    }
    if (detailCompanyTicker) {
      hints.push({ id: "open-ticker", key: "o", label: "pen", onPress: openDetailTicker });
    }
    return hints;
  }, [detailCompanyTicker, openDetailTicker, startUpgrade, state]);

  // The free tier sees the head of a list; the footer says so, the `u` hint
  // is the way out, and no count of what is hidden is drawn.
  const partialList = state.status === "ready"
    && activeTab === "companies"
    && !!selectedList
    && !state.companies.loadingMore
    && !state.companies.hasMore
    && !state.companies.error
    && state.companies.blurredCompanyCount > 0;

  usePaneFooter("buildout", () => ({
    info: updateBuildoutFooterInfo(state, activeTab, selectedList, {
      favoriteMessage,
      upgradeMessage,
      partialList,
      onUpgrade: startUpgrade,
    }),
    hints: footerHints,
  }), [activeTab, favoriteMessage, footerHints, partialList, selectedList, startUpgrade, state, upgradeMessage]);

  const handleHeaderClick = useCallback((columnId: string) => {
    const nextColumnId = columnId as BuildoutColumnId;
    setSortColumnId((current) => {
      if (current === nextColumnId) {
        setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
        return current;
      }
      setSortDirection(defaultSortDirection(nextColumnId));
      return nextColumnId;
    });
  }, []);

  const openCompanyList = useCallback((list: BuildoutList) => {
    setSelectedList(list);
    setSelectedIndex(0);
    setDetailRow(null);
    setUpgradeMessage(null);
    setFavoriteMessage(null);
    setSortColumnId("marketCap");
    setSortDirection("desc");
    resetCompanies();
  }, [resetCompanies]);

  const closeCompanyList = useCallback(() => {
    setSelectedList(null);
    setSelectedIndex(0);
    setDetailRow(null);
    setUpgradeMessage(null);
    setFavoriteMessage(null);
    setSortColumnId(null);
    setSortDirection("asc");
  }, []);

  const activateRow = useCallback((row: BuildoutRow) => {
    if (row.kind === "list") {
      openCompanyList(row.item);
      return;
    }
    setDetailRow(row);
  }, [openCompanyList]);

  const updateFavorite = useCallback((key: string, starred: boolean) => {
    setState((current) => applyFavoriteToState(current, key, starred));
    setDetailRow((current) => (
      current && favoriteKey(current) === key ? rowWithFavorite(current, starred) : current
    ));
  }, []);

  const toggleFavorite = useCallback(async (row: BuildoutRow) => {
    if (!favoriteToken) return;
    const key = favoriteKey(row);
    const path = favoriteApiPath(row);
    if (!key || !path || favoriteBusyKeysRef.current.has(key)) return;

    const previous = rowStarred(row);
    const next = !previous;
    favoriteBusyKeysRef.current.add(key);
    setFavoriteBusyKey(key);
    setFavoriteMessage(null);
    updateFavorite(key, next);

    try {
      const response = await buildoutApi<{ starred?: boolean }>(path, favoriteToken, { method: "POST" });
      updateFavorite(key, typeof response.starred === "boolean" ? response.starred : next);
    } catch {
      updateFavorite(key, previous);
      setFavoriteMessage("favorite failed");
    } finally {
      favoriteBusyKeysRef.current.delete(key);
      setFavoriteBusyKey((current) => current === key ? null : current);
    }
  }, [favoriteToken, updateFavorite]);

  const toggleFavoriteRow = useCallback((row: BuildoutRow | null) => {
    if (!canFavorite || !row || !favoriteKey(row)) return false;
    void toggleFavorite(row);
    return true;
  }, [canFavorite, toggleFavorite]);

  const activePage = state.status === "ready" ? activeBuildoutPage(state, activeTab, selectedList) : null;
  const loadMoreActiveRows = useTableLoadMore(
    tableScrollRef,
    !!activePage && !activePage.loadingMore && !!activePage.hasMore && !activePage.error,
    () => {
      if (!activePage) return;
      if (activeTab === "companies" && selectedList) {
        void loadCompanies(selectedList, activePage.offset, true);
      } else if (activeTab === "sites") {
        void loadSites(activePage.offset, true);
      } else if (activeTab === "intel") {
        void loadIntel(activePage.offset, true);
      }
    },
    LOAD_MORE_THRESHOLD,
  );

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "u" && state.status === "ready" && state.access !== "pro") {
      event.preventDefault?.();
      event.stopPropagation?.();
      void startUpgrade();
      return true;
    }
    if ((event.name === "s" || event.name === "f") && toggleFavoriteRow(selectedRow)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (event.name === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    // Esc and Backspace close an open list through the stack below.
    return false;
  }, [refresh, selectedRow, startUpgrade, state, toggleFavoriteRow]);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "u" && state.status === "ready" && state.access !== "pro") {
      event.preventDefault?.();
      event.stopPropagation?.();
      void startUpgrade();
      return true;
    }
    if ((event.name === "s" || event.name === "f") && toggleFavoriteRow(detailRow)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (event.name !== "o" || !detailCompanyTicker) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    openDetailTicker();
    return true;
  }, [detailCompanyTicker, detailRow, openDetailTicker, startUpgrade, state, toggleFavoriteRow]);

  const renderCell = useCallback((
    row: BuildoutRow,
    column: BuildoutColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => renderBuildoutCell(row, column, rowState, {
    favoriteBusyKey,
    toggleFavorite,
  }), [favoriteBusyKey, toggleFavorite]);

  if (state.status === "loading") {
    return <Box padding={1}><Spinner label={`Loading ${BUILDOUT_NAME}...`} /></Box>;
  }

  if (state.status === "error") {
    return (
      <Box padding={1}>
        <EmptyState title={`Could not load ${BUILDOUT_NAME}.`} message={state.message} />
      </Box>
    );
  }

  const listOpen = activeTab === "companies" && !!selectedList;
  const tableHeight = Math.max(1, height - 1 - (listOpen ? 1 : 0));
  const table = (
    <DataTableStackView<BuildoutRow, BuildoutColumn>
      focused={focused}
      detailOpen={!!detailRow}
      onBack={() => setDetailRow(null)}
      detailTitle={detailRow ? rowTitle(detailRow) : undefined}
      detailContent={(
        <BuildoutDetail
          row={detailRow}
          width={width}
          height={height}
          catalog={tickerCatalog}
          openTicker={openTicker}
          canFavorite={canFavorite}
          favoriteBusyKey={favoriteBusyKey}
          onToggleFavorite={toggleFavorite}
        />
      )}
      rootWidth={width}
      rootHeight={tableHeight}
      columns={columns}
      items={rows}
      selection={{
        kind: "index",
        selectedIndex,
        onChange: (index) => setSelectedIndex(index),
      }}
      onActivate={activateRow}
      sortColumnId={sortColumnId}
      sortDirection={sortDirection}
      onHeaderClick={handleHeaderClick}
      getItemKey={rowKey}
      renderCell={renderCell}
      emptyContent={renderBuildoutPageStatus(state, activeTab, selectedList)}
      emptyStateTitle={selectedList ? "No companies" : "No rows"}
      onRootKeyDown={handleRootKeyDown}
      onDetailKeyDown={handleDetailKeyDown}
      onBodyScrollActivity={loadMoreActiveRows}
      scrollRef={tableScrollRef}
      resetScrollKey={`${activeTab}:${selectedList?.slug ?? "lists"}`}
    />
  );

  // Tabs on top; below them a list opened from Companies is a stack level with
  // the shared Back row, and a company opened from that list is the table's
  // own detail. The outer stack only listens while the inner detail is closed.
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <BuildoutPaneHeader
        activeTab={activeTab}
        focused={focused && !detailRow}
        onSelectTab={setActiveTab}
      />
      <PageStackView
        focused={focused && !detailRow}
        detailOpen={listOpen}
        onBack={closeCompanyList}
        detailTitle={selectedList?.name}
        rootContent={table}
        detailContent={table}
      />
    </Box>
  );
}
