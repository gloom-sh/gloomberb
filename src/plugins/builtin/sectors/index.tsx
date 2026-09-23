import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box } from "../../../ui";
import { DataTableView, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter, type DataTableCell, type DataTableKeyEvent, type DataTableVisibleRange, type PaneFooterSegment } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { formatCurrency, formatPercentRaw } from "../../../utils/format";
import { useAssetData, useDebouncedPluginPaneState, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { isStreamCarryingQuote, useVisibleBoardSymbols } from "../shared/use-quote-board";
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
  applySectorReload,
  buildSectorColumns,
  nextSortPreference,
  normalizeRowsForCollection,
  overlayLiveSectorQuote,
  sectorRowFollowsQuote,
  sectorRowIssues,
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

/**
 * Prices, the day move and the returns stream; the year of history behind the
 * returns only reloads on the app's research cadence. While the feed is not
 * carrying a fund, the last load failed, or a fund printed in a session the
 * board has not rolled to, the snapshot reloads quietly at this pace.
 */
const SECTOR_FALLBACK_REFRESH_MS = 60_000;

const sectorQuoteKey = (etf: string) => buildQuoteKey({ symbol: etf, exchange: "" });

/** The value as printed (two decimals), so a move that rounds to zero is neither signed nor coloured. */
const shownPercent = (value: number) => Math.round(value * 100) / 100 || 0;

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
    "rowsByCollection:v4",
    INITIAL_ROWS_BY_COLLECTION,
  );
  const [lastRefreshByCollection, setLastRefreshByCollection] = useDebouncedPluginPaneState<SectorRefreshByCollection>(
    "lastRefreshByCollection:v2",
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
  const liveStreaming = useLiveStreamingSetting();
  // Funds on screen stream first when the plan caps how many symbols stream.
  // A sort on a live column reorders rows as quotes tick, so the window is
  // only known in the fixed orders; otherwise every fund counts as on screen.
  const [visibleRange, setVisibleRange] = useState<DataTableVisibleRange | null>(null);
  const liveSort = sortPreference.columnId !== "name" && sortPreference.columnId !== "etf";
  const windowSymbols = useMemo(
    () => (liveSort ? [] : sortRows(rows, sortPreference).map((row) => row.etf)),
    [liveSort, rows, sortPreference],
  );
  const visibleSymbols = useVisibleBoardSymbols(windowSymbols, liveSort ? null : visibleRange);
  const quoteTargets = useMemo<QuoteSubscriptionTarget[]>(() => activeItems.map((item) => {
    const selected = item.etf === selectedEtf;
    const visible = !visibleSymbols || visibleSymbols.has(item.etf) || selected;
    return {
      symbol: item.etf,
      exchange: "",
      surface: "screener",
      visible,
      selected,
      weight: selected ? 100 : visible ? 70 : 20,
    };
  }), [activeItems, selectedEtf, visibleSymbols]);
  const { entries: liveEntries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(quoteTargets, {
    freshnessScopeKey: `sectors:${activeCollection.id}`,
    liveStreaming,
  });
  // Live values stay out of the persisted rows: writing every tick would churn
  // pane persistence. Unchanged rows keep their object for the table's memo.
  const liveRowCache = useRef(new WeakMap<SectorRow, { quote: Quote | null; row: SectorRow }>());
  const liveRows = useMemo(() => rows.map((row) => {
    const quote = resolveEntryData(liveEntries.get(sectorQuoteKey(row.etf)));
    const cached = liveRowCache.current.get(row);
    if (cached && cached.quote === quote) return cached.row;
    const live = overlayLiveSectorQuote(row, quote);
    liveRowCache.current.set(row, { quote, row: live });
    return live;
  }), [liveEntries, rows]);
  // With streaming off, the board's own quote poll is the feed.
  const feedCoversBoard = useMemo(() => rows.every((row) => {
    if (row.loading) return true;
    const entry = liveEntries.get(sectorQuoteKey(row.etf));
    const quote = resolveEntryData(entry);
    const carried = liveStreaming
      ? isStreamCarryingQuote(entry, subscriptionStartedAt, freshnessNow)
      : !!quote && quote.stale !== true && (entry?.fetchedAt ?? 0) >= subscriptionStartedAt;
    return carried && !!quote && sectorRowFollowsQuote(row, quote);
  }), [freshnessNow, liveEntries, liveStreaming, rows, subscriptionStartedAt]);
  const sortedRows = useMemo(() => sortRows(liveRows, sortPreference), [liveRows, sortPreference]);
  const lastRefreshMs = lastRefreshByCollection[activeCollection.id] ?? null;
  const loading = rows.some((row) => row.loading);
  const tabs = useMemo(() => SECTOR_COLLECTIONS.map((collection) => ({
    label: collection.label,
    value: collection.id,
  })), []);
  /**
   * A full load marks every row loading and replaces it. A background one,
   * the automatic refresh, never flashes "loading", never cancels a full load
   * in flight, and writes only the rows that changed.
   */
  const load = useCallback((background: boolean) => {
    if (!background) fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    const collectionId = activeCollection.id;
    const sectorDefs = activeItems;
    const updateRows = (updater: (rows: SectorRow[]) => SectorRow[]) => {
      setRowsByCollection((prev) => updateRowsForCollection(prev, collectionId, sectorDefs, updater));
    };
    const clearLoading = (rows: SectorRow[]) => (
      rows.some((row) => row.loading) ? rows.map((row) => ({ ...row, loading: false })) : rows
    );

    if (!dataProvider) {
      setLoadError("No market data provider connected.");
      updateRows(clearLoading);
      return;
    }

    if (!background) updateRows((rows) => rows.map((row) => ({ ...row, loading: true })));

    loadSectorRows(sectorDefs, dataProvider).then((outcomes) => {
      if (fetchGenRef.current !== gen) return;
      const loadedByEtf = new Map(outcomes.map((outcome) => [outcome.etf, outcome.row]));
      updateRows((rows) => applySectorReload(rows, loadedByEtf, background));

      const loadedCount = outcomes.filter((outcome) => outcome.row).length;
      setLoadError(loadedCount === 0 ? "Sector data unavailable" : null);
      // A refresh that returned nothing must not claim the board is current.
      if (loadedCount === 0) return;
      setLastRefreshByCollection((prev) => ({ ...prev, [collectionId]: Date.now() }));
    }).catch(() => {
      if (fetchGenRef.current !== gen) return;
      setLoadError("Sector data unavailable");
      if (!background) updateRows(clearLoading);
    });
  }, [activeCollection.id, activeItems, dataProvider, setLastRefreshByCollection, setRowsByCollection]);
  const fetchAll = useCallback(() => load(false), [load]);
  const refreshInBackground = useCallback(() => load(true), [load]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const fallbackRefresh = !feedCoversBoard || loadError != null;
  useAutoRefresh(lastRefreshMs, refreshInBackground, { intervalMs: fallbackRefresh ? SECTOR_FALLBACK_REFRESH_MS : null });

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
          text: row.changePercent !== null ? formatPercentRaw(shownPercent(row.changePercent)) : "—",
          color: selectedColor ?? (row.changePercent !== null ? priceColor(shownPercent(row.changePercent)) : colors.textDim),
        };
      case "return1M":
        return {
          text: row.loading && row.return1M === null ? "…" : row.return1M !== null ? formatPercentRaw(shownPercent(row.return1M)) : "—",
          color: selectedColor ?? (row.return1M !== null ? priceColor(shownPercent(row.return1M)) : colors.textDim),
        };
      case "return1Y":
        return {
          text: row.loading && row.return1Y === null ? "…" : row.return1Y !== null ? formatPercentRaw(shownPercent(row.return1Y)) : "—",
          color: selectedColor ?? (row.return1Y !== null ? priceColor(shownPercent(row.return1Y)) : colors.textDim),
        };
      case "bar":
        return {
          text: "",
          content: <SectorMoveBar changePercent={row.changePercent} width={column.width} />,
        };
    }
  }, []);

  const updatedAgo = useUpdatedAgo(lastRefreshMs);
  const returnAsOfDate = rows.map((row) => row.returnAsOfDate).filter((date): date is string => !!date).sort().at(-1);
  // Rows with a value the source could not supply are a limitation of the
  // table on screen; they sit behind the footer's warning indicator, one line
  // per ETF, rather than as a count beside the status.
  const rowIssueNotices = rows
    .filter((row) => !row.loading && sectorRowIssues(row).length > 0)
    .map((row) => `${row.etf}: ${sectorRowIssues(row).join(" · ")}`);
  usePaneNoticeFooter({ registrationId: "sectors:row-issues", notices: rowIssueNotices, focused });

  usePaneFooter("sectors", () => {
    const info: PaneFooterSegment[] = [];
    if (loading) info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    if (loadError) info.push({ id: "error", parts: [{ text: loadError, tone: "warning" }] });
    if (returnAsOfDate) info.push({ id: "return-as-of", parts: [{ text: `returns as of ${returnAsOfDate}`, tone: "muted" }] });
    if (updatedAgo) info.push({ id: "updated", parts: [{ text: `checked ${updatedAgo}`, tone: "muted" }] });
    // Keep the leading current failure readable when the pane is narrow; separate
    // flex children would each shrink it to a few characters beside routine status.
    return { info: info.length > 0 ? [{ id: "status", parts: info.flatMap((segment, index) => [
      ...(index > 0 ? [{ text: "·", tone: "muted" as const }] : []), ...segment.parts,
    ]) }] : [] };
  }, [loadError, loading, returnAsOfDate, updatedAgo]);

  const selectCollection = (value: string) => {
    const nextId = value as SectorCollectionId;
    setActiveCollectionId(nextId);
    setSelectedEtf(null);
  };
  const tabsInHeader = usePaneHeaderTabs({ tabs, activeValue: activeCollection.id, onSelect: selectCollection, focused });
  const rootBefore = tabsInHeader ? undefined : (
    <Box height={1} flexShrink={0} paddingX={1} flexDirection="column">
      <Tabs
        tabs={tabs}
        activeValue={activeCollection.id}
        onSelect={selectCollection}
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
      visibleRangeKey={`${activeCollection.id}:${sortPreference.columnId}:${sortPreference.direction}`}
      onVisibleRangeChange={setVisibleRange}
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

  paneTemplates: [
    {
      id: "sectors-pane",
      paneId: "sectors",
      label: "Sector Performance",
      description: "S&P 500 sector and industry performance sorted by daily change.",
      keywords: ["sector", "sectors", "industry", "semis", "defense", "food", "leisure", "etf", "xlk", "xlv", "xlf", "performance", "spdr", "sp"],
      shortcut: { prefix: "BI" },
      headless: sectorsHeadless,
    },
  ],
};
