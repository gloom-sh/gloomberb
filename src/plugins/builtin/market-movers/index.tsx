import { Box } from "../../../ui";
import { nextHeaderSort } from "../../../utils/sort-values";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, EmptyState, usePaneFooter, usePaneTabs, type DataTableKeyEvent } from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { publicTickerKey } from "../../../utils/exchanges";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAssetData, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { useQuoteBoard } from "../shared/use-quote-board";
import {
  attachMarketMoversPersistence,
  MARKET_SUMMARY_SYMBOLS,
  resetMarketMoversPersistence,
  type ScreenerQuote,
  type MarketSummaryQuote,
} from "./screener";
import {
  DEFAULT_SORT_PREFERENCE,
  INDEX_SHORT,
  TABS,
  createRows,
  overlayMarketMoverQuotes,
  resolveSummarySymbols,
  resolveTabs,
  sortRows,
  summaryQuoteFromQuote,
  type MarketMoverColumn,
  type MarketMoverRow,
  type MarketMoverSortPreference,
  type ScreenerTabId,
  type TabId,
} from "./model";
import { loadMarketMoverTab } from "./client";
import { summaryFooterSegments } from "./footer";
import { isSessionTab, resolveActiveTab, usSessionAt, type UsSession } from "./session";
import { SessionMoversBody } from "./session-body";
import { marketMoversHeadless } from "./headless";
import { buildMarketMoverColumns, renderMarketMoverCell } from "./table";
import {
  LIVE_STREAMING_QUICK_SETTING,
  useLiveStreamingSetting,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";
import {
  buildScreenerQuoteTargets,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";


/** Stable identity: a fresh literal here would reload the board every render. */
const NO_SAVED_SELECTION: string[] = [];
const SESSION_CHECK_MS = 30_000;
const NO_QUOTES: ScreenerQuote[] = [];
const moverKey = (row: Pick<ScreenerQuote, "symbol" | "exchange">) => publicTickerKey(row.symbol, row.exchange);

/** What is trading in New York, re-read every half minute so the pane follows 04:00, 09:30 and 16:00. */
function useUsSession(): UsSession {
  const [session, setSession] = useState(() => usSessionAt(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => {
      const next = usSessionAt(Date.now());
      setSession((current) => (current.key === next.key ? current : next));
    }, SESSION_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  return session;
}

function MarketMoversPane({ focused, width, height }: PaneProps) {
  const liveStreaming = useLiveStreamingSetting();
  const [savedTabs] = usePaneSettingValue<string[]>("tabs", NO_SAVED_SELECTION);
  const [savedSummarySymbols] = usePaneSettingValue<string[]>("summarySymbols", NO_SAVED_SELECTION);
  const tabs = useMemo(() => resolveTabs(savedTabs), [savedTabs]);
  const summarySymbols = useMemo(() => resolveSummarySymbols(savedSummarySymbols), [savedSummarySymbols]);
  // Pane state rather than local state, so a restored layout opens on the tab
  // the user picked. `--list` on the CLI and screenshots land in `requestedTab`,
  // which holds until the user picks a tab, whatever session is trading.
  const [savedTab, setSavedTab] = usePluginPaneState<TabId>("activeTab", tabs[0]!.id);
  const [pickedIn, setPickedIn] = usePluginPaneState<string | null>("activeTabSession", null);
  const [requestedTab, setRequestedTab] = usePluginPaneState<TabId | null>("requestedTab", null);
  const access = usePlanAccess();
  const session = useUsSession();
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const activeTab = resolveActiveTab({
    tabs: tabIds,
    saved: savedTab,
    pickedIn,
    session,
    requested: requestedTab,
    sessionListsOpen: access.signedIn && access.emailVerified && access.hasProAccess,
  });

  // The index summary is a quote board like any other, so it runs on the shared
  // one instead of a third parallel pipeline against the same upstream.
  const { quotes: summaryBoard } = useQuoteBoard(summarySymbols, { liveStreaming });
  const summaryQuotes = useMemo<MarketSummaryQuote[]>(() => (
    summarySymbols
      .map((symbol) => {
        const quote = summaryBoard.get(symbol)?.quote;
        return quote ? summaryQuoteFromQuote(symbol, quote) : null;
      })
      .filter((quote): quote is MarketSummaryQuote => !!quote)
  ), [summaryBoard, summarySymbols]);

  const tabItems = tabs.map((tab) => ({ label: tab.label, value: tab.id }));
  const selectTab = (value: string) => {
    setSavedTab(value as TabId);
    setPickedIn(session.key);
    if (requestedTab) setRequestedTab(null);
  };
  const { strip: tabStrip } = usePaneTabs({ tabs: tabItems, activeValue: activeTab, onSelect: selectTab, focused, compact: true, variant: "bare" });

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabStrip && <Box height={1} paddingX={1}>{tabStrip}</Box>}
      {isSessionTab(activeTab) ? (
        <SessionMoversBody
          view={activeTab}
          height={height - (tabStrip ? 1 : 0)}
          session={session}
          focused={focused}
          width={width}
          summaryQuotes={summaryQuotes}
          liveStreaming={liveStreaming}
        />
      ) : (
        <ScreenerMoversBody
          activeTab={activeTab}
          focused={focused}
          width={width}
          summaryQuotes={summaryQuotes}
          liveStreaming={liveStreaming}
        />
      )}
    </Box>
  );
}

/** Gainers, losers, most active and trending: day screeners with live quotes on the rows. */
function ScreenerMoversBody({ activeTab, focused, width, summaryQuotes, liveStreaming }: {
  activeTab: ScreenerTabId;
  focused: boolean;
  width: number;
  summaryQuotes: MarketSummaryQuote[];
  liveStreaming: boolean;
}) {
  const dataProvider = useAssetData();
  const { pinTicker } = usePluginTickerActions();
  const [quotes, setQuotes] = useState<ScreenerQuote[]>([]);
  const [loadedTab, setLoadedTab] = useState<TabId | null>(null);
  const visibleQuotes = loadedTab === activeTab ? quotes : NO_QUOTES;
  // The first load starts before the effect runs; an empty board is not "no data".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<MarketMoverSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [moversStale, setMoversStale] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);

  const fetchGenRef = useRef(0);

  const quoteTargets = useMemo(
    () => buildScreenerQuoteTargets(visibleQuotes, selectedSymbol),
    [visibleQuotes, selectedSymbol],
  );
  const {
    entries: liveQuoteEntries,
    freshnessNow,
    subscriptionStartedAt,
  } = useLiveQuoteEntries(quoteTargets, {
    freshnessScopeKey: `market-movers:${activeTab}`,
    liveStreaming,
  });
  const resolvedQuotes = useMemo(
    () => overlayMarketMoverQuotes(visibleQuotes, liveQuoteEntries),
    [liveQuoteEntries, visibleQuotes],
  );
  const feedStatus = useMemo(
    () => resolveScreenerQuoteFeedStatus(quoteTargets, liveQuoteEntries, {
      now: freshnessNow,
      subscriptionStartedAt,
    }),
    [freshnessNow, liveQuoteEntries, quoteTargets, subscriptionStartedAt],
  );
  const columns = useMemo(() => buildMarketMoverColumns(width), [width]);
  const rankedRows = useMemo(() => createRows(resolvedQuotes), [resolvedQuotes]);
  const rows = useMemo(() => sortRows(rankedRows, sortPreference), [rankedRows, sortPreference]);
  const selectedIdx = selectedSymbol
    ? rows.findIndex((row) => moverKey(row) === selectedSymbol)
    : -1;
  useEffect(() => {
    if (selectedSymbol && selectedIdx >= 0) return;
    const firstRow = rows[0];
    if (firstRow) {
      setSelectedSymbol(moverKey(firstRow));
    } else if (selectedSymbol !== null) {
      setSelectedSymbol(null);
    }
  }, [rows, selectedIdx, selectedSymbol]);

  const loadTab = useCallback(async (
    tab: ScreenerTabId,
    options?: { forceRefresh?: boolean; background?: boolean },
  ) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    if (!options?.background) {
      setLoading(true);
      setLoadError(null);
    }

    try {
      const result = await loadMarketMoverTab(tab, dataProvider, {
        forceRefresh: options?.forceRefresh,
      });
      if (fetchGenRef.current !== gen) return;

      setQuotes(result.quotes);
      setLoadedTab(tab);
      setMoversStale(result.stale);
      if (!options?.background) setSelectedSymbol(null);
      setLoadError(null);
      setLastLoadedAt(Date.now());
    } catch {
      if (fetchGenRef.current !== gen) return;
      setMoversStale(true);
      setLoadError("Market movers temporarily unavailable");
    }
    finally {
      if (fetchGenRef.current === gen && !options?.background) setLoading(false);
    }
  }, [dataProvider]);

  useEffect(() => {
    setSelectedSymbol(null);
    void loadTab(activeTab);
  }, [activeTab, loadTab]);

  const backgroundRefresh = useCallback(() => {
    void loadTab(activeTab, { background: true });
  }, [activeTab, loadTab]);
  useAutoRefresh(lastLoadedAt, backgroundRefresh);

  const openSymbol = useCallback((row: MarketMoverRow) => {
    pinTicker(moverKey(row), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null });
  }, [pinTicker]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextHeaderSort(current, columnId as MarketMoverColumn["id"], {
      resetTo: DEFAULT_SORT_PREFERENCE,
    }));
  }, []);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => loadTab(activeTab, { forceRefresh: true }), { stopPropagation: true })
  ), [activeTab, loadTab]);

  usePaneFooter("market-movers", () => ({
    info: [
      ...(loadError ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }] : []),
      ...summaryFooterSegments(summaryQuotes),
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
      ...(moversStale && loadedTab === activeTab ? [{
        id: "stale",
        parts: [{ text: "stale", tone: "muted" as const }],
      }] : []),
    ],
  }), [activeTab, feedStatus, loadedTab, loadError, loading, moversStale, summaryQuotes]);

  return (
    <DataTableView<MarketMoverRow, MarketMoverColumn>
      focused={focused}
      selection={{
        kind: "id",
        selectedId: selectedSymbol,
        getId: moverKey,
        onChange: (symbol) => setSelectedSymbol(symbol),
      }}
      onRootKeyDown={handleTableKeyDown}
      resetScrollKey={activeTab}
      sortable
      columns={columns}
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={moverKey}
      onActivate={openSymbol}
      renderCell={renderMarketMoverCell}
      selectedTextOverridesCellColor
      emptyStateTitle={loading ? "Loading movers..." : loadError ?? "No movers returned."}
      emptyContent={loadError ? (
        <Box paddingX={1} paddingY={1}>
          <EmptyState title={loadError} message="Try again in a moment." />
        </Box>
      ) : undefined}
    />
  );
}

export const marketMoversModule: PluginModule = {
  setup(ctx) {
    attachMarketMoversPersistence(ctx.persistence);
  },

  dispose() {
    resetMarketMoversPersistence();
  },

  panes: [
    {
      id: "market-movers",
      name: "Market Movers",
      icon: "T",
      component: MarketMoversPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 36 },
      tableExport: true,
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting({
        title: "Market Movers Settings",
        values: {
          tabs: resolveTabs(context.settings.tabs as string[] | undefined).map((tab) => tab.id),
          summarySymbols: resolveSummarySymbols(context.settings.summarySymbols as string[] | undefined),
        },
        fields: [
          {
            key: "tabs",
            label: "Lists",
            type: "ordered-multi-select",
            options: TABS.map((tab) => ({ value: tab.id, label: tab.label })),
          },
          {
            key: "summarySymbols",
            label: "Index summary",
            type: "ordered-multi-select",
            options: MARKET_SUMMARY_SYMBOLS.map((symbol) => ({
              value: symbol,
              label: INDEX_SHORT[symbol] ?? symbol,
            })),
          },
        ],
      }, context.settings),
    },
  ],

  paneTemplates: [
    {
      id: "market-movers-pane",
      paneId: "market-movers",
      label: "Market Movers",
      description: "Top gainers, losers, most active, and trending tickers, pre-market and after-hours movers, and gaps.",
      keywords: ["movers", "gainers", "losers", "active", "trending", "screener", "top", "premarket", "pre-market", "after-hours", "gaps", "gap"],
      shortcut: { prefix: "MOST" },
      headless: marketMoversHeadless,
    },
  ],
};
