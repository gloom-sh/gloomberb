import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box } from "../../../ui";
import { DataTableView, Tabs, usePaneFooter, type DataTableCell, type DataTableKeyEvent, type PaneFooterSegment } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { useAssetData, useDebouncedPluginPaneState, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
import { SectorMoveBar } from "./move-bar";
import {
  SECTOR_COLLECTIONS,
  collectionSettingKey,
  getSectorCollection,
  resolveCollectionItems,
  type SectorCollectionId,
} from "./sector-data";
import {
  DEFAULT_COLLECTION_ID,
  DEFAULT_SORT_PREFERENCE,
  INITIAL_REFRESH_BY_COLLECTION,
  INITIAL_ROWS_BY_COLLECTION,
  buildSectorColumns,
  nextSortPreference,
  normalizeRowsForCollection,
  sortRows,
  updateRowsForCollection,
  type SectorColumn,
  type SectorRefreshByCollection,
  type SectorRow,
  type SectorRowsByCollection,
  type SectorSortPreference,
} from "./sector-model";
import { loadSectorRows } from "./client";
import { sectorsHeadless } from "./headless";

export { sectorsHeadless } from "./headless";

/** Stable identity: a fresh literal here would refetch the board every render. */
const NO_SAVED_ETFS: string[] = [];

function SectorPerformancePane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { navigateTicker } = usePluginTickerActions();
  const [activeCollectionId, setActiveCollectionId] = usePluginPaneState<SectorCollectionId>(
    "activeCollectionId",
    DEFAULT_COLLECTION_ID,
  );
  const activeCollection = getSectorCollection(activeCollectionId);
  const [savedSectorEtfs] = usePaneSettingValue<string[]>("sectorEtfs", NO_SAVED_ETFS);
  const [savedIndustryEtfs] = usePaneSettingValue<string[]>("industryEtfs", NO_SAVED_ETFS);
  const activeItems = useMemo(
    () => resolveCollectionItems(
      activeCollection.id,
      activeCollection.id === "industries" ? savedIndustryEtfs : savedSectorEtfs,
    ),
    [activeCollection.id, savedIndustryEtfs, savedSectorEtfs],
  );
  const [rowsByCollection, setRowsByCollection] = useDebouncedPluginPaneState<SectorRowsByCollection>(
    "rowsByCollection:v1",
    INITIAL_ROWS_BY_COLLECTION,
  );
  const [lastRefreshByCollection, setLastRefreshByCollection] = useDebouncedPluginPaneState<SectorRefreshByCollection>(
    "lastRefreshByCollection:v1",
    INITIAL_REFRESH_BY_COLLECTION,
  );
  const [selectedEtf, setSelectedEtf] = usePluginPaneState<string | null>("selectedEtf", null);
  const [sortPreference, setSortPreference] = usePluginPaneState<SectorSortPreference>(
    "sortPreference",
    DEFAULT_SORT_PREFERENCE,
  );

  const fetchGenRef = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const columns = useMemo(() => buildSectorColumns(width), [width]);
  const rows = useMemo(
    () => normalizeRowsForCollection(rowsByCollection, activeCollection.id, activeItems),
    [activeCollection.id, activeItems, rowsByCollection],
  );
  const sortedRows = useMemo(() => sortRows(rows, sortPreference), [rows, sortPreference]);
  const lastRefreshMs = lastRefreshByCollection[activeCollection.id] ?? null;
  const loading = rows.some((row) => row.loading);
  const tabs = useMemo(() => SECTOR_COLLECTIONS.map((collection) => ({
    label: collection.label,
    value: collection.id,
  })), []);
  const fetchAll = useCallback(() => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    const collectionId = activeCollection.id;
    const sectorDefs = activeItems;

    if (!dataProvider) {
      setLoadError("No market data provider connected.");
      setRowsByCollection((prev) => updateRowsForCollection(prev, collectionId, sectorDefs, (rows) => (
        rows.map((row) => ({ ...row, loading: false }))
      )));
      return;
    }

    setRowsByCollection((prev) => updateRowsForCollection(prev, collectionId, sectorDefs, (rows) => (
      rows.map((row) => ({ ...row, loading: true }))
    )));

    loadSectorRows(sectorDefs, dataProvider).then((outcomes) => {
      if (fetchGenRef.current !== gen) return;
      const loadedByEtf = new Map(outcomes.map((outcome) => [outcome.etf, outcome.row]));
      setRowsByCollection((prev) => updateRowsForCollection(prev, collectionId, sectorDefs, (rows) => (
        rows.map((row) => ({ ...row, ...(loadedByEtf.get(row.etf) ?? {}), loading: false }))
      )));

      const loadedCount = outcomes.filter((outcome) => outcome.row).length;
      setLoadError(loadedCount === 0 ? "Sector data unavailable" : null);
      // A refresh that returned nothing must not claim the board is current.
      if (loadedCount === 0) return;
      setLastRefreshByCollection((prev) => ({ ...prev, [collectionId]: Date.now() }));
    }).catch(() => {
      if (fetchGenRef.current !== gen) return;
      setLoadError("Sector data unavailable");
      setRowsByCollection((prev) => updateRowsForCollection(prev, collectionId, sectorDefs, (rows) => (
        rows.map((row) => ({ ...row, loading: false }))
      )));
    });
  }, [activeCollection.id, activeItems, dataProvider, setLastRefreshByCollection, setRowsByCollection]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useAutoRefresh(lastRefreshMs, fetchAll);

  useEffect(() => {
    if (activeCollectionId === activeCollection.id) return;
    setActiveCollectionId(activeCollection.id);
  }, [activeCollection.id, activeCollectionId, setActiveCollectionId]);

  useEffect(() => {
    if (selectedEtf && sortedRows.some((row) => row.etf === selectedEtf)) return;
    const firstRow = sortedRows[0];
    if (firstRow && selectedEtf !== firstRow.etf) {
      setSelectedEtf(firstRow.etf);
    }
  }, [selectedEtf, setSelectedEtf, sortedRows]);

  const openRow = useCallback((row: SectorRow) => {
    navigateTicker(row.etf);
  }, [navigateTicker]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, [setSortPreference]);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "r") {
      event.preventDefault?.();
      fetchAll();
      return true;
    }
    return false;
  }, [fetchAll]);

  const renderCell = useCallback((
    row: SectorRow,
    column: SectorColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "name":
        return { text: row.name, color: selectedColor ?? colors.text };
      case "etf":
        return { text: row.etf, color: selectedColor ?? colors.textDim };
      case "price":
        if (row.loading && row.price === null) {
          return { text: "…", color: selectedColor ?? colors.textDim };
        }
        return {
          text: row.price !== null ? formatCurrency(row.price, row.currency) : "—",
          color: selectedColor ?? (row.price !== null ? colors.text : colors.textDim),
        };
      case "changePercent":
        return {
          text: row.changePercent !== null ? formatPercentRaw(row.changePercent) : "—",
          color: selectedColor ?? (row.changePercent !== null ? priceColor(row.changePercent) : colors.textDim),
        };
      case "return1M":
        return {
          text: row.loading && row.return1M === null ? "…" : row.return1M !== null ? formatPercentRaw(row.return1M) : "—",
          color: selectedColor ?? (row.return1M !== null ? priceColor(row.return1M) : colors.textDim),
        };
      case "return1Y":
        return {
          text: row.loading && row.return1Y === null ? "…" : row.return1Y !== null ? formatPercentRaw(row.return1Y) : "—",
          color: selectedColor ?? (row.return1Y !== null ? priceColor(row.return1Y) : colors.textDim),
        };
      case "bar":
        return {
          text: "",
          content: <SectorMoveBar changePercent={row.changePercent} width={column.width} />,
        };
    }
  }, []);

  const updatedAgo = useUpdatedAgo(lastRefreshMs);

  usePaneFooter("sectors", () => {
    const info: PaneFooterSegment[] = [];
    if (loading) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (loadError) info.push({ id: "error", parts: [{ text: loadError, tone: "warning" }] });
    if (updatedAgo) info.push({ id: "updated", parts: [{ text: `updated ${updatedAgo}`, tone: "muted" }] });
    return { info };
  }, [loadError, loading, updatedAgo]);

  const rootBefore = (
    <Box height={1} paddingX={1}>
      <Tabs
        tabs={tabs}
        activeValue={activeCollection.id}
        onSelect={(value) => {
          const nextId = value as SectorCollectionId;
          setActiveCollectionId(nextId);
          setSelectedEtf(null);
        }}
        compact
        variant="bare"
        focused={focused}
      />
    </Box>
  );

  return (
    <DataTableView<SectorRow, SectorColumn>
      focused={focused}
      selection={{
        kind: "id",
        selectedId: selectedEtf,
        getId: (row) => row.etf,
        onChange: (id, row, _index, reason) => {
          if (reason === "pointer" && id === selectedEtf) {
            openRow(row);
            return;
          }
          setSelectedEtf(id);
        },
      }}
      onActivate={openRow}
      onRootKeyDown={handleTableKeyDown}
      rootBefore={rootBefore}
      rootWidth={width}
      rootHeight={height}
      resetScrollKey={activeCollection.id}
      columns={columns}
      items={sortedRows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row) => row.etf}
      renderCell={renderCell}
      emptyStateTitle={loadError ?? "No sectors selected."}
    />
  );
}

export const sectorsModule: PluginModule = {
  panes: [
    {
      id: "sectors",
      name: "Sector Performance",
      icon: "S",
      component: SectorPerformancePane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 82, height: 18 },
      tableExport: true,
      settings: (context) => ({
        title: "Sector Performance Settings",
        values: {
          sectorEtfs: resolveCollectionItems("sectors", context.settings.sectorEtfs as string[] | undefined)
            .map((item) => item.etf),
          industryEtfs: resolveCollectionItems("industries", context.settings.industryEtfs as string[] | undefined)
            .map((item) => item.etf),
        },
        fields: SECTOR_COLLECTIONS.map((collection) => ({
          key: collectionSettingKey(collection.id),
          label: collection.label,
          type: "ordered-multi-select" as const,
          options: collection.items.map((item) => ({
            value: item.etf,
            label: item.name,
            description: item.etf,
          })),
        })),
      }),
    },
  ],

  setup(ctx) {
    ctx.registerCommand({
      id: "sectors-sp",
      label: "Sector Performance",
      description: "S&P 500 sector and industry performance sorted by daily change.",
      keywords: ["sector", "sectors", "sp", "performance"],
      category: "data",
      shortcut: "SP",
      execute: () => {
        ctx.createPaneFromTemplate("sectors-pane");
      },
    });
  },

  paneTemplates: [
    {
      id: "sectors-pane",
      paneId: "sectors",
      label: "Sector Performance",
      description: "S&P 500 sector and industry performance sorted by daily change.",
      keywords: ["sector", "sectors", "industry", "semis", "defense", "food", "leisure", "etf", "xlk", "xlv", "xlf", "performance", "spdr"],
      shortcut: { prefix: "BI" },
      headless: sectorsHeadless,
    },
  ],
};
