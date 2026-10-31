import { CLOUD_PLAN_KEY } from "../../shared/cloud-upgrade";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, type ScrollBoxRenderable, useRendererHost } from "../../../../ui";
import {
  DataTableStackView,
  PageStackView,
  PaneStatusBody,
  useTableLoadMore,
  usePaneFooter,
  usePaneTabs,
  type DataTableKeyEvent,
  type PaneHint,
} from "../../../../components";
import { ChoiceDialog } from "../../../../components/ui";
import { handleRefreshKey } from "../../../../components/data-table/table-pane";
import type { PaneProps } from "../../../../types/plugin";
import { useOptionalDialog, type PromptContext } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { logFailure } from "../../../../utils/log-failure";
import { useRowNotes } from "../../../../components/ui/row-notes";
import { nextHeaderSort, type SortPreference } from "../../../../utils/sort-values";
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
import {
  activeBuildoutPage,
  renderBuildoutPageStatus,
  updateBuildoutFooterInfo,
} from "./status";
import { useBuildoutDataRuntime } from "../data-runtime";
import { GEO_SCOPE_STATE_KEY } from "../../world-venue-map/scope";
import type { GeoScope } from "../../world-venue-map/local-layers";
import { boardRows, boardThemes, resolveBoardTheme, ThemeBoard, ThemeStats, themeStatRows, useThemeStepKeys } from "./themes";

const BUILDOUT_UPGRADE_URL = "https://thebuildout.ai/pricing";

/** A symbol the rest of the app can open: the dataset writes some Asian listings by number alone. */
function linkableTicker(value: string | null | undefined): string | null {
  const symbol = tickerSymbol(value);
  return symbol && /^[A-Z][A-Z0-9.-]*$/.test(symbol) ? symbol : null;
}

function sameScope(left: GeoScope | null, right: GeoScope | null): boolean {
  return left?.key === right?.key && left?.label === right?.label;
}

/** A star a row's company or site did not take: said by its star cell, in full at the top of its detail. */
const favoriteNoteKey = (row: BuildoutRow) => favoriteKey(row) ?? rowKey(row);

function favoriteFailureText(row: BuildoutRow, starring: boolean, error: unknown): string {
  // The service may answer with a page of its own; its first line says enough.
  const reason = error instanceof Error ? error.message.trim().split("\n")[0]!.slice(0, 240) : "";
  return `Could not ${starring ? "star" : "unstar"} ${rowTitle(row)}${reason ? `: ${reason}` : "."}`;
}


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
  const clearFavoriteNotesRef = useRef<() => void>(() => {});
  const [activeTab, setActiveTab] = usePaneStateValue<BuildoutTabId>("activeTab", "themes");
  const [selectedList, setSelectedList] = useState<BuildoutList | null>(null);
  const [themeSlug, setThemeSlug] = usePaneStateValue<string | null>("themeSlug", null);
  const [, setCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);
  const [, setGeoScope] = usePaneStateValue<GeoScope | null>(GEO_SCOPE_STATE_KEY, null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailRow, setDetailRow] = useState<BuildoutRow | null>(null);
  const [sort, setSort] = useState<SortPreference<BuildoutColumnId>>({ columnId: null, direction: "asc" });
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [favoriteBusyKey, setFavoriteBusyKey] = useState<string | null>(null);

  const handleBeforeLoad = useCallback(() => {
    favoriteBusyKeysRef.current.clear();
    setDetailRow(null);
    setSelectedList(null);
    setUpgradeMessage(null);
    clearFavoriteNotesRef.current();
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
    themeSlug,
  });
  const themes = useMemo(() => (state.status === "ready" ? boardThemes(state.lists) : []), [state]);
  const themeList = useMemo(() => resolveBoardTheme(themes, themeSlug), [themeSlug, themes]);
  // The list whose companies the table shows: the board's theme, or the one opened from Companies.
  const currentList = activeTab === "themes" ? themeList : selectedList;
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
    const nextColumn: BuildoutColumnId | null = activeTab === "companies" || activeTab === "themes"
      ? currentList ? "marketCap" : null
      : activeTab === "sites" ? "capture" : "time";
    setSort({ columnId: nextColumn, direction: defaultSortDirection(nextColumn) });
  }, [activeTab, currentList?.slug]);

  const rows = useMemo(
    () => sortRows(activeRows(state, activeTab, currentList), sort.columnId, sort.direction),
    [activeTab, currentList, sort, state],
  );
  // Until the next star on that row, or a reload.
  const favoriteNotes = useRowNotes<BuildoutRow, string>(rows, { key: favoriteNoteKey });
  const { setNote: setFavoriteNote, noteFor: favoriteNoteFor } = favoriteNotes;
  clearFavoriteNotesRef.current = favoriteNotes.clearNotes;
  const columns = useMemo(
    () => columnsForTab(activeTab, currentList, canFavorite, width),
    [activeTab, canFavorite, currentList, width],
  );
  const selectedRow = rows[selectedIndex] ?? rows[0] ?? null;

  // Panes linked to this one follow the company under the cursor, and a linked map can widen to the
  // theme it belongs to. Off the company tabs both stay where they were.
  const cursorCompany = detailRow?.kind === "company" ? detailRow.item : selectedRow?.kind === "company" ? selectedRow.item : null;
  const cursorTicker = linkableTicker(cursorCompany?.ticker);
  useEffect(() => {
    if (cursorTicker) setCursorSymbol(cursorTicker);
  }, [cursorTicker, setCursorSymbol]);
  const companyTab = activeTab === "themes" || activeTab === "companies";
  const themeScope = companyTab && currentList && currentList.slug !== "all" ? currentList : null;
  useEffect(() => {
    if (!companyTab) return;
    const next: GeoScope | null = themeScope ? { key: `theme:${themeScope.slug}`, label: themeScope.name } : null;
    setGeoScope((current) => (sameScope(current, next) ? current : next));
  }, [companyTab, setGeoScope, themeScope?.name, themeScope?.slug]);
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
    }).catch(logFailure("buildout.pane", "Choose open target failed"));
    const target = openTargets.find((entry) => entry.id === chosen);
    if (target) openTarget(target);
  }, [dialog, openTarget, openTargets]);

  // The free tier sees the head of a list; the footer says so, the `$` hint
  // is the way out, and no count of what is hidden is drawn.
  const partialList = state.status === "ready"
    && companyTab
    && !!currentList
    && !state.companies.loadingMore
    && !state.companies.hasMore
    && !state.companies.error
    && state.companies.blurredCompanyCount > 0;

  const handleHeaderClick = useCallback((columnId: string) => {
    setSort((current) => nextHeaderSort(current, columnId as BuildoutColumnId, { firstDirection: defaultSortDirection }));
  }, []);

  const openCompanyList = useCallback((list: BuildoutList) => {
    setSelectedList(list);
    setSelectedIndex(0);
    setDetailRow(null);
    setUpgradeMessage(null);
    setSort({ columnId: "marketCap", direction: "desc" });
    resetCompanies();
  }, [resetCompanies]);

  const closeCompanyList = useCallback(() => {
    setSelectedList(null);
    setSelectedIndex(0);
    setDetailRow(null);
    setUpgradeMessage(null);
    setSort({ columnId: null, direction: "asc" });
  }, []);

  const activateRow = useCallback((row: BuildoutRow) => {
    if (row.kind === "list") {
      openCompanyList(row.item);
      return;
    }
    setDetailRow(row);
  }, [openCompanyList]);

  const selectTheme = useCallback((list: BuildoutList) => {
    setThemeSlug(list.slug);
  }, [setThemeSlug]);

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
    setFavoriteNote(key, null);
    updateFavorite(key, next);

    try {
      const response = await buildoutApi<{ starred?: boolean }>(path, favoriteToken, { method: "POST" });
      updateFavorite(key, typeof response.starred === "boolean" ? response.starred : next);
    } catch (error) {
      // The star goes back, and the row says it did not take.
      updateFavorite(key, previous);
      setFavoriteNote(key, favoriteFailureText(row, next, error));
    } finally {
      favoriteBusyKeysRef.current.delete(key);
      setFavoriteBusyKey((current) => current === key ? null : current);
    }
  }, [favoriteToken, setFavoriteNote, updateFavorite]);

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
    info: updateBuildoutFooterInfo(state, activeTab, currentList, {
      upgradeMessage,
      partialList,
      onUpgrade: startUpgrade,
      quoteFreshness: detailQuoteFreshness,
    }),
    hints: footerHints,
  }), [activeTab, currentList, detailQuoteFreshness, footerHints, partialList, startUpgrade, state, upgradeMessage]);

  const activePage = state.status === "ready" ? activeBuildoutPage(state, activeTab, currentList) : null;
  const loadMoreActiveRows = useTableLoadMore(
    tableScrollRef,
    !!activePage && !activePage.loadingMore && !!activePage.hasMore && !activePage.error,
    () => {
      if (!activePage) return;
      if (companyTab && currentList) {
        void loadCompanies(currentList, activePage.offset, true);
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
    // Esc and Backspace close an open list through the stack below.
    return handleRefreshKey(event, refresh, { stopPropagation: true });
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
    favoriteFailed: favoriteNoteFor(row) !== null,
    toggleFavorite,
  }), [favoriteBusyKey, favoriteNoteFor, toggleFavorite]);

  useThemeStepKeys({ themes, selectedSlug: themeList?.slug ?? null, enabled: focused && activeTab === "themes" && !detailRow, onSelect: selectTheme });

  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs,
    activeValue: activeTab,
    onSelect: (value) => setActiveTab(value as BuildoutTabId),
    focused: focused && !detailRow,
    compact: true,
    variant: "bare",
  });

  // The strip stays over the first load and a failed one, as over every tab's own.
  if (state.status === "loading" || state.status === "error") {
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {tabStrip && <Box height={1}>{tabStrip}</Box>}
        {state.status === "loading" ? <PaneStatusBody loading subject={BUILDOUT_NAME} />
          : <PaneStatusBody error={state.message} subject={BUILDOUT_NAME} retry={{ onRetry: refresh }} />}
      </Box>
    );
  }

  const listOpen = activeTab === "companies" && !!selectedList;
  // Themes: the board, the theme in figures, then its companies; an open company takes the whole body.
  const themesBody = activeTab === "themes" && !detailRow;
  const bodyHeight = Math.max(1, height - tabRows);
  const boardHeight = themesBody ? boardRows(bodyHeight) : 0;
  const statHeight = themesBody ? themeStatRows(themeList, width) : 0;
  const tableHeight = Math.max(1, bodyHeight - (listOpen ? 1 : 0) - boardHeight - statHeight);
  const table = (
    <DataTableStackView<BuildoutRow, BuildoutColumn>
      focused={focused}
      detailOpen={!!detailRow}
      onBack={() => setDetailRow(null)}
      detailTitle={detailRow ? rowTitle(detailRow) : undefined}
      detailContent={(
        <BuildoutDetail
          row={detailRow}
          note={detailRow ? favoriteNoteFor(detailRow) : null}
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
        onChange: setSelectedIndex,
      }}
      onActivate={activateRow}
      // The lists start unsorted, and every table sorts by its headers.
      sortable
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={rowKey}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyContent={renderBuildoutPageStatus(state, activeTab, currentList)}
      emptyStateTitle={currentList ? "No companies" : "No rows"}
      onRootKeyDown={handleRootKeyDown}
      onDetailKeyDown={handleDetailKeyDown}
      onBodyScrollActivity={loadMoreActiveRows}
      scrollRef={tableScrollRef}
      resetScrollKey={`${activeTab}:${currentList?.slug ?? "lists"}`}
    />
  );

  if (activeTab === "themes") {
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {tabStrip && <Box height={1}>{tabStrip}</Box>}
        {boardHeight > 0 ? (
          <ThemeBoard
            themes={themes}
            selectedSlug={themeList?.slug ?? null}
            width={width}
            height={boardHeight}
            onSelect={selectTheme}
          />
        ) : null}
        {themesBody ? <ThemeStats list={themeList} width={width} /> : null}
        {table}
      </Box>
    );
  }

  // Tabs on top; below them a list opened from Companies is a stack level with
  // the shared Back row, and a company opened from that list is the table's
  // own detail. The outer stack only listens while the inner detail is closed.
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {tabStrip && <Box height={1}>{tabStrip}</Box>}
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
