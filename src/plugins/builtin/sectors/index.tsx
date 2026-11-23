import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box } from "../../../ui";
import { DataTableView, usePaneFooter, usePaneTabs, type DataTableCell, type DataTableKeyEvent, type DataTableVisibleRange } from "../../../components";
import { handleRefreshKey, loadingErrorFooterInfo } from "../../../components/data-table/table-pane";
import { ageFooterSegment, savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { connectionHealth, recoversDataRequests } from "../../../core/connection-health";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { useAppSelector, usePaneInstance, usePaneSettingValue } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { MISSING_VALUE, formatCurrency, formatPercentRaw } from "../../../utils/format";
import { useAssetData, useDebouncedPluginPaneState, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { Quote } from "../../../types/financials";
import type { ExtendedSession } from "../../../market-data/market/status";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { isStreamCarryingQuote, useVisibleBoardSymbols } from "../shared/use-quote-board";
import { useQuoteDelayFooter } from "../shared/cloud-upgrade";
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
  sectorExtendedSessions,
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
import { loadSectorRows, type SectorHistories } from "./client";
import { sectorsHeadless } from "./headless";
import { membersCache, themesCache } from "../themes/client";
import { themesHeadless } from "../themes/headless";
import { ThemesBoard, useOpenTheme } from "../themes/pane";


/** Stable identity: a fresh literal here would refetch the board every render. */
const NO_SAVED_ETFS: string[] = [];

/**
 * Prices, the day move and the returns stream; the year of history behind the
 * returns only reloads on the app's research cadence. While the feed is not
 * carrying a fund, the last load failed, or a fund printed in a session the
 * board has not rolled to, the quotes reload quietly at this pace, read
 * against the history already loaded: outside regular hours that is all an
 * open board asks for.
 */
const SECTOR_FALLBACK_REFRESH_MS = 60_000;

const sectorQuoteKey = (etf: string) => buildQuoteKey({ symbol: etf, exchange: "" });

/** The value as printed (two decimals), so a move that rounds to zero is neither signed nor coloured. */
const shownPercent = (value: number) => Math.round(value * 100) / 100 || 0;

/** Thematic baskets (`THEM`), the tab beside the ETF collections. */
const THEMES_TAB = "themes";
type SectorTabId = SectorCollectionId | typeof THEMES_TAB;
const SECTOR_TABS = [
  ...SECTOR_COLLECTIONS.map((collection) => ({ label: collection.label, value: collection.id })),
  { label: "Themes", value: THEMES_TAB },
];

function SectorPerformancePane({ focused, width, height }: PaneProps) {
  // `THEM` opens this pane with a theme param, as did the old Thematic Baskets pane.
  const opensOnThemes = usePaneInstance()?.params?.theme !== undefined;
  const [activeTabId, setActiveTabId] = usePluginPaneState<SectorTabId>(
    "activeCollectionId",
    opensOnThemes ? THEMES_TAB : DEFAULT_COLLECTION_ID,
  );
  const activeTab: SectorTabId = activeTabId === THEMES_TAB ? THEMES_TAB : getSectorCollection(activeTabId).id;
  const [, setSelectedEtf] = usePluginPaneState<string | null>("selectedEtf", null);
  const [openTheme] = useOpenTheme();

  useEffect(() => {
    if (activeTabId === activeTab) return;
    setActiveTabId(activeTab);
  }, [activeTab, activeTabId, setActiveTabId]);

  const selectTab = (value: string) => {
    setActiveTabId(value as SectorTabId);
    setSelectedEtf(null);
  };
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: SECTOR_TABS,
    activeValue: activeTab,
    onSelect: selectTab,
    // An open theme's members take the keys, as in any stack detail.
    focused: focused && !(activeTab === THEMES_TAB && openTheme),
    compact: true,
    variant: "bare",
  });
  const rootBefore = tabStrip ? <Box height={1} flexShrink={0} paddingX={1} flexDirection="column">{tabStrip}</Box> : undefined;

  return activeTab === THEMES_TAB
    ? <ThemesBoard focused={focused} width={width} height={height} tabStrip={rootBefore} tabRows={tabRows} />
    : <EtfBoard collectionId={activeTab} focused={focused} width={width} height={height} rootBefore={rootBefore} />;
}

interface EtfBoardProps {
  collectionId: SectorCollectionId;
  focused: boolean;
  width: number;
  height: number;
  rootBefore: ReactNode;
}

/** The Sectors and Industries tabs: one board of ETFs with live quotes. */
function EtfBoard({ collectionId, focused, width, height, rootBefore }: EtfBoardProps) {
  const dataProvider = useAssetData();
  const { navigateTicker } = usePluginTickerActions();
  const activeCollection = getSectorCollection(collectionId);
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
  const researchIntervalMinutes = useAppSelector((state) => state.config.refreshIntervalMinutes);
  /** The history the last full load read, for the funds it was read for, which quote refreshes reuse. */
  const historiesRef = useRef<{ funds: string; loadedAt: number; histories: SectorHistories } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<{ collectionId: SectorCollectionId; savedAt: number | null } | null>(null);

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
  // A pre-market or after-hours column only while a fund has such a print.
  const extendedSessionsKey = sectorExtendedSessions(liveRows).join(",");
  const columns = useMemo(
    () => buildSectorColumns(width, extendedSessionsKey ? extendedSessionsKey.split(",") as ExtendedSession[] : []),
    [extendedSessionsKey, width],
  );
  const lastRefreshMs = lastRefreshByCollection[activeCollection.id] ?? null;
  const refreshFailed = fallback?.collectionId === activeCollection.id;
  const savedAt = refreshFailed ? fallback.savedAt ?? lastRefreshMs : null;
  const loading = rows.some((row) => row.loading);
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
    // A background refresh reads its quotes against the history already loaded
    // for these funds, until that history is one research interval old.
    const funds = sectorDefs.map((item) => item.etf).join(",");
    const stored = historiesRef.current;
    // The app's own research cadence (app-runtime): a minute at least, and an unreadable setting reloads.
    const researchMs = Math.max(1, researchIntervalMinutes) * 60_000;
    const reuse = background && stored?.funds === funds && Date.now() - stored.loadedAt < researchMs;
    const histories: SectorHistories = reuse ? stored!.histories : new Map();
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

    loadSectorRows(sectorDefs, dataProvider, { histories, revalidate: true }).then((outcomes) => {
      if (fetchGenRef.current !== gen) return;
      const checked = outcomes.length > 0 && outcomes.every((outcome) => outcome.checked);
      if (checked && !reuse) historiesRef.current = { funds, loadedAt: Date.now(), histories };
      const loadedByEtf = new Map(outcomes.map((outcome) => [outcome.etf, outcome.row]));
      updateRows((rows) => clearLoading(applySectorReload(rows, loadedByEtf, background || !checked && rows.some((row) => row.returnAsOfDate))));

      const loadedCount = outcomes.filter((outcome) => outcome.row).length;
      setLoadError(loadedCount === 0 ? "Sector data unavailable" : null);
      const savedTimes = outcomes.flatMap((outcome) => outcome.savedAt == null ? [] : [outcome.savedAt]);
      setFallback(checked ? null : { collectionId, savedAt: savedTimes.length ? Math.min(...savedTimes) : null });
      if (!checked) return;
      setLastRefreshByCollection((prev) => ({ ...prev, [collectionId]: Date.now() }));
    }).catch(() => {
      if (fetchGenRef.current !== gen) return;
      setLoadError("Sector data unavailable");
      setFallback({ collectionId, savedAt: null });
      if (!background) updateRows(clearLoading);
    });
  }, [activeCollection.id, activeItems, dataProvider, researchIntervalMinutes, setLastRefreshByCollection, setRowsByCollection]);
  const fetchAll = useCallback(() => load(false), [load]);
  const refreshInBackground = useCallback(() => load(true), [load]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => connectionHealth.subscribeRecovery((sourceId) => {
    if (refreshFailed && recoversDataRequests(sourceId)) refreshInBackground();
  }), [refreshFailed, refreshInBackground]);
  const fallbackRefresh = !feedCoversBoard || refreshFailed || loadError != null;
  useAutoRefresh(lastRefreshMs, refreshInBackground, { intervalMs: fallbackRefresh ? SECTOR_FALLBACK_REFRESH_MS : null });

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

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => handleRefreshKey(event, fetchAll), [fetchAll]);

  const renderCell = useCallback((
    row: SectorRow,
    column: SectorColumn,
  ): DataTableCell => {
    switch (column.id) {
      case "name":
        return { text: row.name, color: colors.text };
      case "etf":
        return { text: row.etf, color: !row.loading && sectorRowIssues(row).length > 0 ? colors.warning : colors.textDim };
      case "price":
        if (row.loading && row.price === null) {
          return { text: "…", color: colors.textDim };
        }
        return {
          text: row.price !== null ? formatCurrency(row.price, row.currency) : MISSING_VALUE,
          color: row.price !== null ? colors.text : colors.textDim,
        };
      case "changePercent":
        return {
          text: row.changePercent !== null ? formatPercentRaw(shownPercent(row.changePercent)) : MISSING_VALUE,
          color: row.changePercent !== null ? priceColor(shownPercent(row.changePercent)) : colors.textDim,
        };
      case "preMarket":
      case "afterHours": {
        // The extended print's move from the close in LAST.
        const move = row.extendedSession === (column.id === "preMarket" ? "PRE" : "POST") ? row.extendedChangePercent ?? null : null;
        return {
          text: move !== null ? formatPercentRaw(shownPercent(move)) : MISSING_VALUE,
          value: move,
          color: move !== null ? priceColor(shownPercent(move)) : colors.textDim,
        };
      }
      case "return1M":
        return {
          text: row.loading && row.return1M === null ? "…" : row.return1M !== null ? formatPercentRaw(shownPercent(row.return1M)) : MISSING_VALUE,
          color: row.return1M !== null ? priceColor(shownPercent(row.return1M)) : colors.textDim,
        };
      case "return1Y":
        return {
          text: row.loading && row.return1Y === null ? "…" : row.return1Y !== null ? formatPercentRaw(shownPercent(row.return1Y)) : MISSING_VALUE,
          color: row.return1Y !== null ? priceColor(shownPercent(row.return1Y)) : colors.textDim,
        };
      case "bar": {
        const signed = row.changePercent !== null ? formatPercentRaw(shownPercent(row.changePercent)) : MISSING_VALUE;
        return {
          text: signed,
          content: <Box flexDirection="row" width={column.width} overflow="hidden" aria-label={signed}>
            <SectorMoveBar changePercent={row.changePercent} width={column.width} />
          </Box>,
        };
      }
    }
  }, []);

  const updatedAgo = useUpdatedAgo(refreshFailed ? null : lastRefreshMs);
  const returnAsOfDate = rows.map((row) => row.returnAsOfDate).filter((date): date is string => !!date).sort().at(-1);
  // A row with a value the source could not supply says so on that row: its
  // ETF in the warning colour, and the reason under the table while it is
  // selected (`rowNote`). The footer is for the whole board.

  // Signed out or free, the ETFs' quotes are delayed ones.
  const quoteDelay = useQuoteDelayFooter(rows.map((row) => (row.loading ? null : { dataSource: row.quoteDataSource })), "sectors-delay");
  usePaneFooter("sectors", () => {
    const info = loadingErrorFooterInfo(loading, savedAt == null ? loadError ?? (refreshFailed ? "Couldn't refresh sectors" : null) : null);
    if (returnAsOfDate) info.push({ id: "return-as-of", parts: [{ text: `returns as of ${returnAsOfDate}`, tone: "muted" }] });
    // Keep the leading current failure readable when the pane is narrow; separate
    // flex children would each shrink it to a few characters beside routine status.
    return { info: [
      ...savedCopyFooterInfo([savedAt]),
      ...(info.length > 0 ? [{ id: "status", parts: info.flatMap((segment, index) => [
        ...(index > 0 ? [{ text: "·", tone: "muted" as const }] : []), ...segment.parts,
      ]) }] : []),
      ...(updatedAgo ? [ageFooterSegment(updatedAgo, { verb: "checked" })] : []),
      ...(quoteDelay ? [quoteDelay] : []),
    ] };
  }, [loadError, loading, quoteDelay, refreshFailed, returnAsOfDate, savedAt, updatedAgo]);

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
      rowNote={(row) => !row.loading && sectorRowIssues(row).length > 0 ? `${row.etf}: ${sectorRowIssues(row).join("; ")}.` : null}
      selectedTextOverridesCellColor
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
      // BI and THEM open this pane: THEM sets the theme param; the ETF lists are preferences.
      identitySettings: [],
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
      shortcut: { prefix: "BI", aliases: ["IMAP"] },
      headless: sectorsHeadless,
    },
    {
      id: "themes-pane",
      paneId: "sectors",
      label: "Thematic Baskets",
      description: "Curated themes with equal-weight returns, breadth and member leaders and laggards.",
      keywords: ["themes", "thematic", "baskets", "AI compute", "datacenters", "electrification", "power grid", "nuclear", "uranium", "defense", "aerospace", "cybersecurity", "robotics", "automation", "critical minerals", "crypto", "bitcoin", "bitcoin miners", "miners", "bitcoin mining", "solar", "clean energy", "gold", "silver", "homebuilders", "memory", "chip equipment", "cloud software"],
      shortcut: { prefix: "THEM", argKind: "text", argOnlySelects: true, argPlaceholder: "theme", argOptional: true },
      headless: themesHeadless,
      // The theme param opens the Themes tab, and the named theme's members.
      createInstance: (_context, options) => ({ placement: "floating", params: { theme: options?.arg?.trim() ?? "" } }),
    },
  ],
  setup(ctx) { themesCache.attach(ctx.persistence); membersCache.attach(ctx.persistence); },
  dispose() { themesCache.reset(); membersCache.reset(); },
};
