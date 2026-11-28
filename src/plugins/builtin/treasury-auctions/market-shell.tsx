import { useCallback, useEffect, type ReactNode } from "react";
import {
  DataTableStackView,
  EmptyState,
  PaneStatusBody,
  QueryBar,
  usePaneMenuItems,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type QueryBarSelectFilter,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useSearchUpRootKeyDown } from "../../../components/input-search-bar";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { Box } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { usePluginPaneState } from "../../runtime";
import type { AuctionHistoryWindow } from "./client";
import {
  AUCTION_FILTERS,
  auctionHistoryPhrase,
  nextAuctionHistoryWindow,
  nextFilter,
  type AuctionFilter,
} from "./model";

const FILTER_TABS = AUCTION_FILTERS.map((entry) => ({ label: entry.label, value: entry.value }));

export function useAuctionMarketShell<TRow>({
  focused,
  width,
  height,
  selectedStateKey,
  detailStateKey,
  stale,
  fetchedAt,
  loading,
  totalCount,
  rows,
  getId,
  filter,
  setFilter,
  searchQuery,
  setSearchQuery,
  searchPlaceholder,
  marketFilter,
  viewControl,
  reload,
  autoLoad,
  cycleSort,
}: {
  focused: boolean;
  width: number;
  height: number;
  selectedStateKey: string;
  detailStateKey: string;
  stale: boolean;
  fetchedAt: number | null;
  loading: boolean;
  totalCount: number;
  rows: readonly TRow[];
  getId: (row: TRow) => string;
  filter: AuctionFilter;
  setFilter: (next: AuctionFilter) => void;
  searchQuery: string;
  setSearchQuery: (next: string) => void;
  searchPlaceholder: string | [string, string];
  marketFilter: QueryBarSelectFilter;
  viewControl?: { value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void };
  reload: () => void;
  autoLoad: () => void;
  cycleSort: (step: 1 | -1) => void;
}) {
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(selectedStateKey, null);
  const [detailOpen, setDetailOpen] = usePluginPaneState<boolean>(detailStateKey, false);
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();

  useAutoRefresh(stale ? null : fetchedAt, autoLoad);
  usePaneRefreshKey(reload, { focused, enabled: !searchFocused });

  const selected = rows.find((row) => getId(row) === selectedId) ?? null;

  useEffect(() => {
    // Before the first answer there is nothing to match a restored selection
    // against, so leave it alone rather than clear it.
    if (totalCount === 0 && loading) return;
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      setDetailOpen(false);
      return;
    }
    if (!selectedId || !rows.some((row) => getId(row) === selectedId)) {
      setSelectedId(getId(rows[0]!));
    }
  }, [getId, loading, rows, selectedId, setDetailOpen, setSelectedId, totalCount]);

  const selectFilter = useCallback((next: AuctionFilter) => {
    setFilter(next);
    setDetailOpen(false);
  }, [setDetailOpen, setFilter]);
  const cycleFilter = useCallback(() => {
    setFilter(nextFilter(filter));
    setDetailOpen(false);
  }, [filter, setDetailOpen, setFilter]);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "f")) {
      stopSearchFocusNavigation(event);
      cycleFilter();
      return true;
    }
    if (isPlainKey(event, "]") || isPlainKey(event, "[")) {
      stopSearchFocusNavigation(event);
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleFilter, cycleSort]);
  const handleRootKeyDown = useSearchUpRootKeyDown(focusSearch, handlePaneKey);

  // The footer's [] steps to the next sort column; the pane menu names the way back. "Sort by…" there picks a column directly.
  usePaneMenuItems("treasury-auctions:sort-keys", () => detailOpen || totalCount === 0 ? null : [
    { id: "sort-previous", label: "Previous Sort Column", accelerator: "[", onSelect: () => cycleSort(-1) },
  ], [cycleSort, detailOpen, totalCount]);

  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: FILTER_TABS,
    activeValue: filter,
    onSelect: (value) => selectFilter(value as AuctionFilter),
    focused: focused && !detailOpen && !searchFocused,
    compact: true,
    variant: "bare",
  });
  const tabs = tabStrip && <Box height={1} flexShrink={0} overflow="hidden">{tabStrip}</Box>;
  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: searchPlaceholder,
        focused: focused && !detailOpen,
        ...searchProps,
      }}
      filters={[marketFilter]}
      view={viewControl}
    />
  );

  return {
    selectedId,
    setSelectedId,
    selected,
    detailOpen,
    setDetailOpen,
    searchFocused,
    focusSearch,
    blurSearch,
    cycleFilter,
    handlePaneKey,
    handleRootKeyDown,
    tabs,
    queryBar,
    rootHeight: Math.max(1, height - tabRows),
  };
}

export function AuctionMarketView<TRow, TCol extends DataTableColumn>({
  width,
  height,
  focused,
  loading,
  error,
  totalCount,
  loadingLabel,
  unavailableTitle,
  shell,
  columns,
  rows,
  getId,
  sortColumnId,
  sortDirection,
  onHeaderClick,
  renderCell,
  detailTitle,
  detailContent,
  searchQuery,
  historyDays,
  itemPlural,
  searchFields,
}: {
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  error: string | null;
  totalCount: number;
  loadingLabel: string;
  unavailableTitle: string;
  shell: ReturnType<typeof useAuctionMarketShell<TRow>>;
  columns: TCol[];
  rows: TRow[];
  getId: (row: TRow) => string;
  sortColumnId: string;
  sortDirection: "asc" | "desc";
  onHeaderClick: (columnId: string) => void;
  renderCell: (row: TRow, column: TCol, index: number, rowState: { selected: boolean }) => DataTableCell;
  detailTitle?: string;
  detailContent: ReactNode;
  searchQuery: string;
  historyDays: AuctionHistoryWindow;
  itemPlural: string;
  searchFields: string;
}) {
  if (loading && totalCount === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {shell.tabs}
        {shell.queryBar}
        <PaneStatusBody loading align="center" loadingLabel={loadingLabel} />
      </Box>
    );
  }
  if (error && totalCount === 0) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {shell.tabs}
        {shell.queryBar}
        <Box padding={1}>
          <EmptyState status="error" title={unavailableTitle} message={error} />
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width} height={height}>
      {shell.tabs}
      <DataTableStackView<TRow, TCol>
        focused={focused && !shell.searchFocused}
        detailOpen={shell.detailOpen && !!shell.selected}
        onBack={() => shell.setDetailOpen(false)}
        detailContent={detailContent}
        detailTitle={detailTitle}
        rootBefore={shell.queryBar}
        onRootKeyDown={shell.handleRootKeyDown}
        onDetailKeyDown={shell.handlePaneKey}
        selection={{
          kind: "id",
          selectedId: shell.selectedId,
          getId,
          onChange: (id) => shell.setSelectedId(id),
        }}
        onActivate={() => {
          shell.blurSearch();
          shell.setDetailOpen(true);
        }}
        rootWidth={width}
        rootHeight={shell.rootHeight}
        columns={columns}
        items={rows}
        sortColumnId={sortColumnId}
        sortDirection={sortDirection}
        onHeaderClick={onHeaderClick}
        getItemKey={getId}
        renderCell={renderCell}
        emptyStateTitle={searchQuery.trim() ? `No matching ${itemPlural}.` : `No recent ${itemPlural}.`}
        emptyStateHint={`${searchQuery.trim() ? "Searched" : "Showing"} ${auctionHistoryPhrase(historyDays)}`
          + `${nextAuctionHistoryWindow(historyDays) ? `; older ${itemPlural} are in the History window setting` : ""}. Search by ${searchFields}.`}
      />
    </Box>
  );
}
