import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableView,
  QueryBar,
  usePaneFooter,
  usePaneMenuItems,
  useQueryBarSearch,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type DataTableVisibleRange,
  type PaneFooterSegment,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneInstance } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference, nextHeaderSort } from "../../../utils/sort-values";
import { useAssetData, usePluginTickerActions } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import {
  boardErrorMessage,
  quoteBoardFooterInfo,
  quoteBoardStatus,
  useQuoteBoard,
  useVisibleBoardSymbols,
  type BoardQuoteMap,
} from "../shared/use-quote-board";
import {
  FUTURES_CONTRACTS,
  FUTURES_SECTOR_LABELS,
  getContractsBySector,
  type FuturesSector,
} from "./contracts";
import {
  buildFuturesRows,
  DEFAULT_FUTURES_SORT,
  effectiveCollapsedSectors,
  futuresRowId,
  type FuturesColumnId,
  type FuturesSortPreference,
  type FuturesTableRow,
} from "./model";
import {
  createFuturesColumns,
  FUTURES_COLUMN_DEFS,
  renderFuturesCell,
  resolveFuturesColumnIds,
  usesSessionText,
  type FuturesColumn,
} from "./table";

export const FUTURES_PANE_ID = "futures";

const FUTURES_SYMBOLS = FUTURES_CONTRACTS.map((contract) => contract.symbol);

const alwaysNavigable = () => true;
const NO_BOARD_QUOTES: BoardQuoteMap = new Map();
/** Columns whose order moves with every tick; the others keep a fixed order. */
const LIVE_SORT_COLUMNS = new Set<string>(["status", "price", "change", "changePercent", "volume", "time"]);

function FuturesPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const dataProvider = useAssetData();
  const paneInstance = usePaneInstance();
  const liveStreaming = useLiveStreamingSetting();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<FuturesSortPreference>(DEFAULT_FUTURES_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const [collapsedSectors, setCollapsedSectors] = useState<ReadonlySet<FuturesSector>>(new Set());
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange | null>(null);

  const contractsBySector = useMemo(() => getContractsBySector(), []);
  // The stream follows the rows on screen; collapsed sectors and filtered-out
  // contracts drop to the off-screen cadence. A sort on a live column moves
  // rows with every tick, so then every listed contract counts as on screen.
  const windowSymbols = useMemo(
    () => buildFuturesRows(contractsBySector, sortPreference, NO_BOARD_QUOTES, {
      query: searchQuery,
      collapsed: collapsedSectors,
    }).map((row) => (row.type === "row" ? row.contract.symbol : null)),
    [collapsedSectors, contractsBySector, searchQuery, sortPreference],
  );
  const liveSort = sortPreference.columnId !== null && LIVE_SORT_COLUMNS.has(sortPreference.columnId);
  const visibleSymbols = useVisibleBoardSymbols(
    windowSymbols,
    liveSort || !visibleRange ? { start: 0, end: windowSymbols.length } : visibleRange,
  );
  const { quotes, refresh } = useQuoteBoard(FUTURES_SYMBOLS, {
    liveStreaming,
    visibleSymbols,
    selectedSymbol: selectedId,
  });
  const visibleCollapsed = effectiveCollapsedSectors(collapsedSectors, searchQuery);
  const rows = useMemo(
    () => buildFuturesRows(contractsBySector, sortPreference, quotes, {
      query: searchQuery,
      collapsed: collapsedSectors,
    }),
    [collapsedSectors, contractsBySector, quotes, searchQuery, sortPreference],
  );

  const visibleColumnIds = useMemo(
    () => resolveFuturesColumnIds(paneInstance?.settings?.columnIds as string[] | undefined),
    [paneInstance?.settings?.columnIds],
  );
  const columns = useMemo<FuturesColumn[]>(
    () => createFuturesColumns(width, visibleColumnIds),
    [visibleColumnIds, width],
  );

  const sessionText = usesSessionText(width);
  const renderCell = useCallback((
    row: FuturesTableRow,
    column: FuturesColumn,
  ) => renderFuturesCell(row, column, quotes, { sessionText }), [quotes, sessionText]);

  const toggleSector = useCallback((sector: FuturesSector) => {
    setCollapsedSectors((current) => {
      const next = new Set(current);
      if (next.has(sector)) next.delete(sector);
      else next.add(sector);
      return next;
    });
  }, []);

  // Memoized so the table's row memo holds while the selection moves.
  const renderSectorHeader = useCallback((row: FuturesTableRow) => (
    row.type === "header"
      ? {
        text: FUTURES_SECTOR_LABELS[row.sector],
        expanded: !visibleCollapsed.has(row.sector),
        onMouseDown: () => toggleSector(row.sector),
      }
      : null
  ), [toggleSector, visibleCollapsed]);

  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => cycleSortPreference<FuturesColumnId>(
      visibleColumnIds,
      current,
      step,
      { allowUnsorted: true },
    ));
  }, [visibleColumnIds]);
  // [ and ] step through the sort orders; the pane menu is where they show.
  usePaneMenuItems(`${FUTURES_PANE_ID}:sort-keys`, () => [
    { id: "sort-next", label: "Next Sort", accelerator: "]", onSelect: () => cycleSort(1) },
    { id: "sort-previous", label: "Previous Sort", accelerator: "[", onSelect: () => cycleSort(-1) },
  ], [cycleSort]);

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((row) => futuresRowId(row) === selectedId)) return;
    const firstNavigable = rows.find((row) => row.type === "row") ?? rows[0];
    setSelectedId(firstNavigable ? futuresRowId(firstNavigable) : null);
  }, [rows, selectedId]);

  // The footer binds the `/` search hint.
  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return true;
    if (isPlainKey(event, "]") || isPlainKey(event, "[")) {
      stopSearchFocusNavigation(event);
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleSort, refresh]);

  const handleRootKeyDown = useCallback((
    event: DataTableKeyEvent,
    context: DataTableRootKeyContext,
  ) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handlePaneKey(event);
  }, [focusSearch, handlePaneKey]);

  const status = quoteBoardStatus(quotes);
  const errorMessage = boardErrorMessage(quotes);
  usePaneFooter(FUTURES_PANE_ID, () => {
    const info: PaneFooterSegment[] = quoteBoardFooterInfo(status);
    if (errorMessage) info.push({ id: "reason", parts: [{ text: errorMessage, tone: "warning" }] });
    return {
      info,
      hints: [{ id: "search", key: "/", label: "search", onPress: focusSearch }],
    };
  }, [
    errorMessage,
    focusSearch,
    status.latestTs,
    status.loading,
    status.stale,
    status.unavailable,
  ]);

  return (
    <DataTableView<FuturesTableRow, FuturesColumn>
      focused={focused && !searchFocused}
      selection={{
        kind: "id",
        selectedId,
        getId: (row) => futuresRowId(row),
        onChange: (id) => setSelectedId(id),
      }}
      isNavigable={alwaysNavigable}
      onActivate={(row) => {
        if (row.type === "header") {
          toggleSector(row.sector);
          return;
        }
        pinTicker(row.contract.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
      }}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={dataProvider ? rows : []}
      sortable
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) => setSortPreference((current) => nextHeaderSort(current, columnId as FuturesColumnId, {
        resetTo: DEFAULT_FUTURES_SORT,
      }))}
      onSortChange={(columnId, direction) => setSortPreference((current) => ({ ...current, columnId: columnId as FuturesSortPreference["columnId"], direction }))}
      getItemKey={futuresRowId}
      visibleRangeKey={windowSymbols.join(",")}
      onVisibleRangeChange={setVisibleRange}
      renderSectionHeader={renderSectorHeader}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={searchQuery.trim()
        ? "No matching contracts."
        : "No market data provider connected."}
      emptyStateHint={searchQuery.trim() ? "Clear search." : undefined}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: searchQuery,
            onChange: setSearchQuery,
            placeholder: "ticker or name",
            focused,
            ...searchProps,
            debounceMs: 80,
          }}
        />
      )}
      onRootKeyDown={handleRootKeyDown}
    />
  );
}

export const futuresModule: PluginModule = {
  panes: [
    {
      id: FUTURES_PANE_ID,
      name: "Futures",
      icon: "F",
      component: FuturesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 76, height: 34 },
      tableExport: true,
      // Resolved per open so the dialog shows the full default set until the
      // user saves a narrower selection.
      settings: (context) => ({
        title: "Futures Settings",
        values: {
          columnIds: resolveFuturesColumnIds(context.settings.columnIds as string[] | undefined),
        },
        fields: [{
          key: "columnIds",
          label: "Columns",
          type: "ordered-multi-select",
          options: FUTURES_COLUMN_DEFS.map((column) => ({
            value: column.id,
            label: column.label,
            description: column.description,
          })),
        }],
      }),
    },
  ],

  paneTemplates: [
    {
      id: "futures-pane",
      paneId: FUTURES_PANE_ID,
      label: "Futures Board",
      description:
        "Front-month futures across equity index, rates, energy, metals, agriculture, and FX with last price, session change, search, and collapsible sectors.",
      keywords: [
        "futures",
        "commodities",
        "crude",
        "oil",
        "gold",
        "silver",
        "copper",
        "corn",
        "wheat",
        "treasuries",
        "contracts",
        "cme",
      ],
      shortcut: { prefix: "FUT" },
    },
  ],
};
