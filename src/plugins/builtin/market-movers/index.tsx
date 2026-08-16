import { Box } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, Tabs, usePaneFooter, type DataTableKeyEvent } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { priceColor } from "../../../theme/colors";
import { formatPercentRaw } from "../../../utils/format";
import { useAssetData, usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import {
  attachMarketMoversPersistence,
  fetchPreferredMarketMovers,
  fetchTrending,
  MARKET_SUMMARY_SYMBOLS,
  resetMarketMoversPersistence,
  type ScreenerQuote,
  type MarketSummaryQuote,
} from "./screener";
import {
  CATEGORY_MAP,
  DEFAULT_SORT_PREFERENCE,
  INDEX_SHORT,
  TABS,
  createRows,
  nextSortPreference,
  screenerQuoteFromQuote,
  sortRows,
  summaryQuoteFromQuote,
  type MarketMoverColumn,
  type MarketMoverRow,
  type MarketMoverSortPreference,
  type TabId,
} from "./model";
import { buildMarketMoverColumns, renderMarketMoverCell } from "./table";
import {
  LIVE_STREAMING_QUICK_SETTING,
  useLiveStreamingSetting,
  withLiveStreamingSetting,
} from "../shared/live-streaming";
import {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "../shared/screener-live-quotes";

function MarketMoversPane({ focused, width, height }: PaneProps) {
  const dataProvider = useAssetData();
  const { pinTicker } = usePluginTickerActions();
  const liveStreaming = useLiveStreamingSetting();
  const [activeTab, setActiveTab] = useState<TabId>("gainers");
  const [quotes, setQuotes] = useState<ScreenerQuote[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [sortPreference, setSortPreference] = useState<MarketMoverSortPreference>(DEFAULT_SORT_PREFERENCE);
  const [summaryQuotes, setSummaryQuotes] = useState<MarketSummaryQuote[]>([]);
  const [moversStale, setMoversStale] = useState(false);

  const fetchGenRef = useRef(0);

  const quoteTargets = useMemo(
    () => buildScreenerQuoteTargets(quotes, selectedSymbol),
    [quotes, selectedSymbol],
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
    () => overlayScreenerQuoteEntries(quotes, liveQuoteEntries),
    [liveQuoteEntries, quotes],
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
    ? rows.findIndex((row) => row.symbol === selectedSymbol)
    : -1;
  useEffect(() => {
    if (selectedSymbol && selectedIdx >= 0) return;
    const firstRow = rows[0];
    if (firstRow) {
      setSelectedSymbol(firstRow.symbol);
    } else if (selectedSymbol !== null) {
      setSelectedSymbol(null);
    }
  }, [rows, selectedIdx, selectedSymbol]);

  // Fetch market summary via the asset-data client.
  useEffect(() => {
    if (!dataProvider) return;
    const loadSummary = async () => {
      if (dataProvider.getQuotesBatch) {
        const batchResults = await dataProvider.getQuotesBatch(
          MARKET_SUMMARY_SYMBOLS.map((symbol) => ({ symbol, exchange: "" })),
        ).catch(() => []);
        const bySymbol = new Map(batchResults.map((result) => [result.target.symbol, result]));
        setSummaryQuotes(
          MARKET_SUMMARY_SYMBOLS
            .map((symbol) => {
              const result = bySymbol.get(symbol);
              return result?.quote ? summaryQuoteFromQuote(symbol, result.quote) : null;
            })
            .filter((quote): quote is MarketSummaryQuote => !!quote),
        );
        return;
      }

      const results = await Promise.all(MARKET_SUMMARY_SYMBOLS.map(async (symbol) => {
        try {
          const quote = await dataProvider.getQuote(symbol, "");
          return quote ? summaryQuoteFromQuote(symbol, quote) : null;
        } catch {
          return null;
        }
      }));
      setSummaryQuotes(
        MARKET_SUMMARY_SYMBOLS
          .map((s) => results.find((r) => r?.symbol === s))
          .filter((r): r is MarketSummaryQuote => !!r),
      );
    };
    loadSummary();
    const interval = setInterval(loadSummary, 60_000);
    return () => clearInterval(interval);
  }, [dataProvider]);

  const loadTab = useCallback(async (
    tab: TabId,
    options?: { forceRefresh?: boolean; background?: boolean },
  ) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    if (!options?.background) {
      setLoading(true);
      setLoadError(null);
    }

    try {
      let data: ScreenerQuote[];

      if (tab === "trending") {
        const trending = await fetchTrending(25, undefined, {
          forceRefresh: options?.forceRefresh,
        });
        if (fetchGenRef.current !== gen) return;

        const resolved: ScreenerQuote[] = [];

        if (dataProvider) {
          const targets = trending.slice(0, 25).map(({ symbol }) => ({ symbol, exchange: "" }));
          if (dataProvider.getQuotesBatch) {
            const batchResults = await dataProvider.getQuotesBatch(targets).catch(() => []);
            for (const result of batchResults) {
              if (fetchGenRef.current !== gen) return;
              if (result.quote) {
                resolved.push(screenerQuoteFromQuote(result.target.symbol, result.quote));
              }
            }
          } else {
            await Promise.allSettled(targets.map(async ({ symbol }) => {
              try {
                const q = await dataProvider.getQuote(symbol, "");
                if (fetchGenRef.current !== gen) return;
                if (q) {
                  resolved.push(screenerQuoteFromQuote(symbol, q));
                }
              } catch { /* skip */ }
            }));
          }
        }

        if (fetchGenRef.current !== gen) return;
        data = trending
          .map((t) => resolved.find((r) => r.symbol === t.symbol))
          .filter((r): r is ScreenerQuote => r !== undefined);
        setMoversStale(false);
      } else {
        const result = await fetchPreferredMarketMovers(CATEGORY_MAP[tab], 25, {
          forceRefresh: options?.forceRefresh,
        });
        if (fetchGenRef.current !== gen) return;
        data = result.quotes;
        setMoversStale(result.stale);
      }

      setQuotes(data);
      if (!options?.background) setSelectedSymbol(null);
      setLoadError(null);
    } catch {
      if (fetchGenRef.current === gen && !options?.background) {
        setLoadError("Market movers temporarily unavailable");
      }
    }
    finally {
      if (fetchGenRef.current === gen && !options?.background) setLoading(false);
    }
  }, [dataProvider]);

  useEffect(() => {
    void loadTab(activeTab);
    const interval = setInterval(() => {
      void loadTab(activeTab, { background: true });
    }, 60_000);
    return () => clearInterval(interval);
  }, [activeTab, loadTab]);

  const openSymbol = useCallback((symbol: string) => {
    pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextSortPreference(current, columnId));
  }, []);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    const key = event.name;

    if (key === "r") {
      event.preventDefault?.();
      event.stopPropagation?.();
      loadTab(activeTab, { forceRefresh: true });
      return true;
    }
    return false;
  }, [activeTab, loadTab]);

  const refreshActiveTab = useCallback(() => {
    void loadTab(activeTab, { forceRefresh: true });
  }, [activeTab, loadTab]);

  usePaneFooter("market-movers", () => ({
    info: [
      ...summaryQuotes.map((idx) => {
        const short = INDEX_SHORT[idx.symbol] ?? idx.symbol;
        return {
          id: `summary:${idx.symbol}`,
          parts: [
            { text: short, tone: "label" as const },
            { text: formatPercentRaw(idx.changePercent), tone: "value" as const, color: priceColor(idx.changePercent), bold: true },
          ],
        };
      }),
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
      ...(moversStale ? [{
        id: "stale",
        parts: [{ text: "stale", tone: "muted" as const }],
      }] : []),
    ],
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress: refreshActiveTab }],
  }), [feedStatus, loading, moversStale, refreshActiveTab, summaryQuotes]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={TABS.map((tab) => ({ label: tab.label, value: tab.id }))}
          activeValue={activeTab}
          onSelect={(value) => {
            setActiveTab(value as TabId);
            setSelectedSymbol(null);
          }}
          compact
          variant="bare"
          focused={focused}
        />
      </Box>

      <DataTableView<MarketMoverRow, MarketMoverColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedSymbol,
          getId: (row) => row.symbol,
          onChange: (symbol) => setSelectedSymbol(symbol),
        }}
        onRootKeyDown={handleTableKeyDown}
        resetScrollKey={activeTab}
        columns={columns}
        items={rows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={handleHeaderClick}
        getItemKey={(row) => `${row.symbol}-${row.rank}`}
        onActivate={(row) => openSymbol(row.symbol)}
        renderCell={renderMarketMoverCell}
        emptyStateTitle={loading ? "Loading movers..." : loadError ?? "No data"}
        emptyStateHint={loadError ? "Try again in a moment." : undefined}
      />
    </Box>
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
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting({ fields: [] }, context.settings),
    },
  ],

  paneTemplates: [
    {
      id: "market-movers-pane",
      paneId: "market-movers",
      label: "Market Movers",
      description: "Top gainers, losers, most active, and trending tickers.",
      keywords: ["movers", "gainers", "losers", "active", "trending", "screener", "top"],
      shortcut: { prefix: "MOST" },
    },
  ],
};
