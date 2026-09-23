import { CLOUD_PLAN_KEY } from "../../shared/cloud-upgrade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, type ScrollBoxRenderable, useRendererHost } from "../../../../ui";
import {
  DataTableStackView,
  PageStackView,
  PaneStatusBody,
  useTableLoadMore,
  usePaneFooter,
  usePaneHeaderTabs,
  type DataTableKeyEvent,
  type PaneHint,
} from "../../../../components";
import { ChoiceDialog } from "../../../../components/ui";
import type { PaneProps } from "../../../../types/plugin";
import { useOptionalDialog, type PromptContext } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePaneStateValue } from "../../../../state/app/context";
import { useInlineTickerQuoteFact, useInlineTickers } from "../../../../state/hooks/inline-tickers";
import { collectUniqueTickerSymbols } from "../../../../tickers/tokenizer";
import { BuildoutDetail } from "../detail";
import { liveCompanyFreshness } from "../detail/company";
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
  rowOpenTargets,
  rowStarred,
  rowTickerSymbols,
  rowTitle,
  rowWithFavorite,
  sortRows,
  tabs,
  type BuildoutOpenTarget,
} from "../table-model";
import { tickerSearchText, tickerSymbol } from "../format";
import { BuildoutPaneHeader } from "./header";
import {
  activeBuildoutPage,
  renderBuildoutPageStatus,
  updateBuildoutFooterInfo,
} from "./status";
import { useBuildoutDataRuntime } from "../data-runtime";

const BUILDOUT_UPGRADE_URL = "https://thebuildout.ai/pricing";


const NO_TICKER_TEXTS: string[] = [];

/** Every string in a detail item that could hold a `$TICKER`. */
function collectTickerTexts(value: unknown, out: string[], depth: number): void {
  if (value == null || depth > 6) return;
  if (typeof value === "string") {
    if (value.includes("$")) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTickerTexts(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectTickerTexts(item, out, depth + 1);
  }
}
export function BuildoutPane({ focused, width, height }: PaneProps) {
  const rendererHost = useRendererHost();
  const dialog = useOptionalDialog();
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
  // The table's cells carry their own badges; this catalog only serves the open
  // detail: its row's tickers, plus the loaded rows' tickers its text mentions.
  // Streaming every loaded row here would subscribe pages of symbols nobody sees.
  const tickerTexts = useMemo(() => {
    if (!detailRow) return NO_TICKER_TEXTS;
    const symbols = new Set<string>(rowTickerSymbols(detailRow));
    const texts: string[] = [];
    collectTickerTexts(detailRow.item, texts, 0);
    const mentioned = new Set(collectUniqueTickerSymbols(texts));
    if (mentioned.size > 0) {
      for (const row of rows) {
        for (const symbol of rowTickerSymbols(row)) {
          if (mentioned.has(symbol)) symbols.add(symbol);
        }
      }
    }
    return [tickerSearchText([...symbols])];
  }, [detailRow, rows]);
  const { catalog: tickerCatalog, openTicker } = useInlineTickers(tickerTexts, { badgeQuotes: true });
  const detailCompany = detailRow?.kind === "company" ? detailRow.item : null;
  const detailCompanyTicker = detailCompany ? tickerSymbol(detailCompany.ticker) : null;
  // The detail swaps in the streamed price; the status bar says what it is.
  const detailQuoteFreshness = useInlineTickerQuoteFact(
    detailCompanyTicker,
    detailCompanyTicker ? tickerCatalog[detailCompanyTicker]?.ticker ?? null : null,
    (quote) => (detailCompany ? liveCompanyFreshness(detailCompany, quote) : null),
  );
  // `o` opens what the row or the open detail links to: straight away when it
  // is one ticker, from a list when there are several or a source link.
  const openTargets = useMemo(
    () => rowOpenTargets(detailRow ?? selectedRow, detailRow ? "detail" : "row"),
    [detailRow, selectedRow],
  );
  const openTarget = useCallback((target: BuildoutOpenTarget) => {
    if (target.kind === "ticker") openTicker(target.symbol);
    else void rendererHost.openExternal(target.url);
  }, [openTicker, rendererHost]);
  const chooseOpenTarget = useCallback(async () => {
    const [first] = openTargets;
    if (!first) return;
    if (openTargets.length === 1 || !dialog) {
      openTarget(first);
      return;
    }
    const chosen = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title="Open"
          choices={openTargets.map((target) => ({ id: target.id, label: target.label, detail: target.detail }))}
        />
      ),
    }).catch(() => undefined);
    const target = openTargets.find((entry) => entry.id === chosen);
    if (target) openTarget(target);
  }, [dialog, openTarget, openTargets]);

  // The free tier sees the head of a list; the footer says so, the `$` hint
  // is the way out, and no count of what is hidden is drawn.
  const partialList = state.status === "ready"
    && activeTab === "companies"
    && !!selectedList
    && !state.companies.loadingMore
    && !state.companies.hasMore
    && !state.companies.error
    && state.companies.blurredCompanyCount > 0;

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

  // Favoriting follows what the keys act on: the open detail, else the cursor row.
  const favoriteTarget = detailRow ?? selectedRow;
  const favoriteTargetKey = canFavorite && favoriteTarget ? favoriteKey(favoriteTarget) : null;
  const footerHints = useMemo<PaneHint[]>(() => {
    const hints: PaneHint[] = [];
    // The key every Pro prompt uses; `u` is the app's install-update key.
    if (state.status === "ready" && state.access !== "pro") {
      hints.push({ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade", onPress: startUpgrade });
    }
    if (favoriteTarget && favoriteTargetKey) {
      const starred = rowStarred(favoriteTarget);
      hints.push({
        id: "favorite",
        key: "s",
        label: starred ? " unstar" : "tar",
        title: starred ? "Unstar" : undefined,
        onPress: () => { toggleFavoriteRow(favoriteTarget); },
        disabled: favoriteBusyKey === favoriteTargetKey,
      });
    }
    if (openTargets.length > 0) {
      hints.push({ id: "open", key: "o", label: "pen", onPress: () => { void chooseOpenTarget(); } });
    }
    return hints;
  }, [chooseOpenTarget, favoriteBusyKey, favoriteTarget, favoriteTargetKey, openTargets.length, startUpgrade, state, toggleFavoriteRow]);

  usePaneFooter("buildout", () => ({
    info: updateBuildoutFooterInfo(state, activeTab, selectedList, {
      favoriteMessage,
      upgradeMessage,
      partialList,
      onUpgrade: startUpgrade,
      quoteFreshness: detailQuoteFreshness,
    }),
    hints: footerHints,
  }), [activeTab, detailQuoteFreshness, favoriteMessage, footerHints, partialList, selectedList, startUpgrade, state, upgradeMessage]);

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

  // Upgrade ($), star (s) and open (o) are footer hints, which bind their keys;
  // the table adds only `f`, the older name for star, and refresh. Plain keys
  // only: Cmd+Shift+S shares the pane and Cmd+Shift+R resizes it.
  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "f") && toggleFavoriteRow(selectedRow)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    // Esc and Backspace close an open list through the stack below.
    return false;
  }, [refresh, selectedRow, toggleFavoriteRow]);

  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!isPlainKey(event, "f") || !toggleFavoriteRow(detailRow)) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }, [detailRow, toggleFavoriteRow]);

  const renderCell = useCallback((
    row: BuildoutRow,
    column: BuildoutColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => renderBuildoutCell(row, column, rowState, {
    favoriteBusyKey,
    toggleFavorite,
  }), [favoriteBusyKey, toggleFavorite]);

  const tabsInHeader = usePaneHeaderTabs({
    tabs,
    activeValue: activeTab,
    onSelect: (value) => setActiveTab(value as BuildoutTabId),
    focused: focused && !detailRow,
  });
  const tabRows = tabsInHeader ? 0 : 1;

  if (state.status === "loading") {
    return <PaneStatusBody loading subject={BUILDOUT_NAME} width={width} height={height} />;
  }

  if (state.status === "error") {
    return <PaneStatusBody error={state.message} subject={BUILDOUT_NAME} width={width} height={height} />;
  }

  const listOpen = activeTab === "companies" && !!selectedList;
  const tableHeight = Math.max(1, height - tabRows - (listOpen ? 1 : 0));
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
      // The lists start unsorted, and every table sorts by its headers.
      sortable
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
      {!tabsInHeader && (
        <BuildoutPaneHeader
          activeTab={activeTab}
          focused={focused && !detailRow}
          onSelectTab={setActiveTab}
        />
      )}
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
