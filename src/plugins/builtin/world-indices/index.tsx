import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTableView } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { usePluginTickerActions } from "../../runtime";
import { useQuoteBoard } from "../shared/use-quote-board";
import { WORLD_INDICES, REGION_LABELS, getIndicesByRegion } from "./indices";
import { useWorldIndicesFooter } from "./footer";
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
  type WorldIndexColumn,
} from "./table";

const REFRESH_INTERVAL_MS = 60_000;
const WORLD_INDEX_SYMBOLS = WORLD_INDICES.map((entry) => entry.symbol);

function WorldIndicesPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const { quotes } = useQuoteBoard(WORLD_INDEX_SYMBOLS, REFRESH_INTERVAL_MS);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<WorldIndexSortPreference>(DEFAULT_SORT_PREFERENCE);

  const indicesByRegion = useMemo(() => getIndicesByRegion(), []);
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

  const renderCell = useCallback((
    row: WorldIndexTableRow,
    column: WorldIndexColumn,
    _index: number,
    rowState: { selected: boolean },
  ) => {
    return renderWorldIndexCell(row, column, rowState, quotes);
  }, [quotes]);

  useWorldIndicesFooter(quotes);

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
      isNavigable={(row) => row.type === "row"}
      onActivate={(_row, index) => openSelected(index)}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={flatRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row) => row.type === "header" ? `header-${row.region}` : row.entry.symbol}
      renderSectionHeader={(row) => row.type === "header"
        ? { text: REGION_LABELS[row.region] }
        : null}
      renderCell={renderCell}
      emptyStateTitle="No indices configured."
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
      defaultFloatingSize: { width: 72, height: 32 },
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
    },
  ],
};
