import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTableView, type DataTableVisibleRange } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { usePaneSettingValue } from "../../../state/app/context";
import { useAssetData, usePluginTickerActions } from "../../runtime";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { useQuoteBoard, useVisibleBoardSymbols } from "../shared/use-quote-board";
import { WORLD_INDICES, REGION_LABELS, getIndicesByRegion, resolveIndexEntries } from "./indices";
import { useWorldIndicesFooter } from "./footer";
import { createPublicPaneShare } from "../shared/public-pane";
import { worldIndicesHeadless } from "./headless";
import {
  buildFlatRows,
  DEFAULT_SORT_PREFERENCE,
  nextSortPreference,
  type WorldIndexSortPreference,
  type WorldIndexTableRow,
} from "./model";
import {
  createWorldIndexColumns,
  renderWorldIndexCell,
  usesSessionText,
  type WorldIndexColumn,
} from "./table";

export { worldIndicesHeadless } from "./headless";

/** Stable identity: a fresh literal here would remount the board every render. */
const NO_SAVED_SYMBOLS: string[] = [];

// Rows are memoized by the table; hoisted adapters keep their identity.
const worldIndexRowKey = (row: WorldIndexTableRow) => (
  row.type === "header" ? `header-${row.region}` : row.entry.symbol
);
const isIndexRow = (row: WorldIndexTableRow) => row.type === "row";
function renderRegionHeader(row: WorldIndexTableRow) {
  return row.type === "header" ? { text: REGION_LABELS[row.region] } : null;
}

function WorldIndicesPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const dataProvider = useAssetData();
  const [savedSymbols] = usePaneSettingValue<string[]>("symbols", NO_SAVED_SYMBOLS);
  const entries = useMemo(() => resolveIndexEntries(savedSymbols), [savedSymbols]);
  const symbols = useMemo(() => entries.map((entry) => entry.symbol), [entries]);
  const liveStreaming = useLiveStreamingSetting();
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<WorldIndexSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange | null>(null);
  const indicesByRegion = useMemo(() => getIndicesByRegion(entries), [entries]);
  // The stream follows the rows on screen. A sort on a live column reorders
  // rows as quotes tick, so the window is only known in the fixed orders; a
  // board this size simply counts as fully on screen otherwise.
  const liveSort = sortPreference.columnId !== null && sortPreference.columnId !== "symbol" && sortPreference.columnId !== "name";
  const windowSymbols = useMemo(
    () => buildFlatRows(indicesByRegion, sortPreference, new Map()).map((row) => (
      row.type === "row" ? row.entry.symbol : null
    )),
    [indicesByRegion, sortPreference],
  );
  const visibleSymbols = useVisibleBoardSymbols(windowSymbols, liveSort ? null : visibleRange);
  const { quotes, refresh } = useQuoteBoard(symbols, { liveStreaming, visibleSymbols, selectedSymbol });

  const flatRows = useMemo(
    () => buildFlatRows(indicesByRegion, sortPreference, quotes),
    [indicesByRegion, quotes, sortPreference],
  );
  const selectedFlatIdx = selectedSymbol
    ? flatRows.findIndex((row) => row.type === "row" && row.entry.symbol === selectedSymbol)
    : -1;
  useEffect(() => {
    if (selectedSymbol && selectedFlatIdx >= 0) return;
    const firstRow = flatRows.find((row) => row.type === "row");
    if (firstRow?.type === "row") {
      setSelectedSymbol(firstRow.entry.symbol);
    } else if (selectedSymbol !== null) {
      setSelectedSymbol(null);
    }
  }, [flatRows, selectedFlatIdx, selectedSymbol]);

  const openSelected = useCallback((flatIdx: number) => {
    const row = flatRows[flatIdx];
    if (!row || row.type !== "row") return;
    pinTicker(row.entry.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [flatRows, pinTicker]);

  const selectFlatIndex = useCallback((flatIdx: number) => {
    const row = flatRows[flatIdx];
    if (!row || row.type !== "row") return;
    setSelectedSymbol(row.entry.symbol);
  }, [flatRows]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, []);

  const columns = useMemo<WorldIndexColumn[]>(() => createWorldIndexColumns(width), [width]);

  const sessionText = usesSessionText(width);
  const renderCell = useCallback((
    row: WorldIndexTableRow,
    column: WorldIndexColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    return renderWorldIndexCell(row, column, rowState, quotes, { sessionText });
  }, [quotes, sessionText]);

  useWorldIndicesFooter(quotes, refresh, focused);

  return (
    <DataTableView<WorldIndexTableRow, WorldIndexColumn>
      focused={focused}
      selection={{
        kind: "id",
        selectedId: selectedSymbol,
        getId: (row) => row.type === "row" ? row.entry.symbol : `header-${row.region}`,
        onChange: (_id, row, index) => {
          if (row.type === "row") selectFlatIndex(index);
        },
      }}
      isNavigable={isIndexRow}
      onActivate={(_row, index) => openSelected(index)}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={dataProvider ? flatRows : []}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={worldIndexRowKey}
      visibleRangeKey={`${sortPreference.columnId}:${sortPreference.direction}`}
      onVisibleRangeChange={setVisibleRange}
      renderSectionHeader={renderRegionHeader}
      renderCell={renderCell}
      emptyStateTitle="No market data provider connected."
    />
  );
}

export const worldIndicesModule: PluginModule = {
  panes: [
    {
      id: "world-indices",
      name: "World Indices",
      icon: "W",
      component: WorldIndicesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 32 },
      tableExport: true,
      // Resolved per open so the dialog shows the full board until the user
      // saves a narrower selection.
      settings: (context) => ({
        title: "World Indices Settings",
        values: {
          symbols: resolveIndexEntries(context.settings.symbols as string[] | undefined)
            .map((entry) => entry.symbol),
        },
        fields: [{
          key: "symbols",
          label: "Indices",
          type: "ordered-multi-select",
          options: WORLD_INDICES.map((entry) => ({
            value: entry.symbol,
            label: entry.shortName,
            description: entry.name,
          })),
        }],
      }),
    },
  ],

  paneTemplates: [
    {
      id: "world-indices-pane",
      paneId: "world-indices",
      label: "World Equity Indices",
      description: "Monitor global equity indices grouped by region.",
      keywords: ["world", "indices", "global", "equity", "markets", "international"],
      shortcut: { prefix: "WEI" },
      headless: worldIndicesHeadless,
      publicShare: createPublicPaneShare("World Equity Indices"),
    },
  ],
};
