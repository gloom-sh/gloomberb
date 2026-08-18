import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  InputSearchBar,
  usePaneFooter,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneFooterSegment,
} from "../../../components";
import { usePaneInstance } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { type InputRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { cycleSortPreference } from "../../../utils/sort-values";
import { usePluginTickerActions } from "../../runtime";
import type { PluginModule } from "../plugin-module";
import {
  quoteBoardFooterInfo,
  quoteBoardStatus,
  useQuoteBoard,
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
  nextFuturesSort,
  type FuturesColumnId,
  type FuturesSortPreference,
  type FuturesTableRow,
} from "./model";
import {
  createFuturesColumns,
  FUTURES_COLUMN_DEFS,
  renderFuturesCell,
  resolveFuturesColumnIds,
  type FuturesColumn,
} from "./table";

export const FUTURES_PANE_ID = "futures";

const REFRESH_INTERVAL_MS = 60_000;
const FUTURES_SYMBOLS = FUTURES_CONTRACTS.map((contract) => contract.symbol);

function FuturesPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const paneInstance = usePaneInstance();
  const { quotes, refresh } = useQuoteBoard(FUTURES_SYMBOLS, REFRESH_INTERVAL_MS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<FuturesSortPreference>(DEFAULT_FUTURES_SORT);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [collapsedSectors, setCollapsedSectors] = useState<ReadonlySet<FuturesSector>>(new Set());
  const searchInputRef = useRef<InputRenderable | null>(null);

  const contractsBySector = useMemo(() => getContractsBySector(), []);
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

  const renderCell = useCallback((
    row: FuturesTableRow,
    column: FuturesColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => renderFuturesCell(row, column, rowState, quotes), [quotes]);

  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((current) => current + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);

  const toggleSector = useCallback((sector: FuturesSector) => {
    setCollapsedSectors((current) => {
      const next = new Set(current);
      if (next.has(sector)) next.delete(sector);
      else next.add(sector);
      return next;
    });
  }, []);

  const cycleSort = useCallback((step: 1 | -1) => {
    setSortPreference((current) => cycleSortPreference<FuturesColumnId>(
      visibleColumnIds,
      current,
      step,
      { allowUnsorted: true },
    ));
  }, [visibleColumnIds]);

  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId && rows.some((row) => futuresRowId(row) === selectedId)) return;
    const firstNavigable = rows.find((row) => row.type === "row") ?? rows[0];
    setSelectedId(firstNavigable ? futuresRowId(firstNavigable) : null);
  }, [rows, selectedId]);

  const handlePaneKey = useCallback((event: DataTableKeyEvent): boolean => {
    if (isPlainKey(event, "r")) {
      stopSearchFocusNavigation(event);
      refresh();
      return true;
    }
    if (isPlainKey(event, "s") || isPlainKey(event, "/")) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "]") || isPlainKey(event, "[")) {
      stopSearchFocusNavigation(event);
      cycleSort(event.name === "]" ? 1 : -1);
      return true;
    }
    return false;
  }, [cycleSort, focusSearch, refresh]);

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
  usePaneFooter(FUTURES_PANE_ID, () => {
    const info: PaneFooterSegment[] = quoteBoardFooterInfo(status);
    if (searchQuery.trim()) {
      info.push({ id: "search", parts: [{ text: `search: ${searchQuery.trim()}`, tone: "value" }] });
    }
    return {
      info,
      hints: [
        { id: "search", key: "s", label: "earch", onPress: focusSearch },
        { id: "refresh", key: "r", label: "efresh", onPress: refresh },
      ],
    };
  }, [
    focusSearch,
    refresh,
    searchQuery,
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
      isNavigable={() => true}
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
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={(columnId) => setSortPreference((current) => nextFuturesSort(current, columnId))}
      getItemKey={(row) => futuresRowId(row)}
      renderSectionHeader={(row) => row.type === "header"
        ? {
          text: `${visibleCollapsed.has(row.sector) ? "▶" : "▼"} ${FUTURES_SECTOR_LABELS[row.sector]}`,
          onMouseDown: () => toggleSector(row.sector),
        }
        : null}
      renderCell={renderCell}
      emptyStateTitle={searchQuery.trim() ? "No matching contracts." : "No contracts configured."}
      emptyStateHint={searchQuery.trim() ? "Clear search or press r to refresh." : "Press s to search."}
      rootBefore={(
        <InputSearchBar
          value={searchQuery}
          focused={focused}
          active={searchFocused}
          width={width}
          focusToken={searchFocusToken}
          inputRef={searchInputRef}
          placeholder="ticker or name"
          debounceMs={80}
          onFocus={focusSearch}
          onBlur={blurSearch}
          onNavigateDown={blurSearch}
          onQueryChange={setSearchQuery}
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
