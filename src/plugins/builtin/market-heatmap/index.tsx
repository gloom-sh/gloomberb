import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useUiCapabilities } from "../../../ui";
import {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  loadingText,
  MetricTreemapSurface,
  PaneStatusBody,
  Tabs,
  unavailableText,
  usePaneFooter,
  usePaneHeaderTabs,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useShortcut } from "../../../react/input";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { GloomPlugin, PaneProps, PaneSettingField } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { tf } from "../../../i18n";
import { priceColor } from "../../../theme/colors";
import { formatCompact, formatCurrency, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useAppSelector, usePaneAppConfig, usePaneSettingValue } from "../../../state/app/context";
import { usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { useFxRatesMap, useTickerFinancialsMap } from "../../../market-data/hooks";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { instrumentFromTicker, type InstrumentRef } from "../../../market-data/request-types";
import {
  buildTrackedCurrencies,
  getCollectionTickersFromConfig,
  getCollectionTypeFromConfig,
} from "../portfolio-list/pane/data";
import { resolvePortfolioTotalsCurrency } from "../portfolio-list/metrics";
import { useThrottledMemo } from "../portfolio-list/use-throttled-memo";
import { PORTFOLIO_REORDER_THROTTLE_MS } from "../portfolio-list/use-throttled-ticker-order";
import {
  MARKET_HEATMAP_UNIVERSES,
  fetchMarketHeatmap,
  resetMarketHeatmapCache,
  type MarketHeatmapUniverseId,
} from "./data";
import {
  PORTFOLIO_HEATMAP_TAB,
  buildPortfolioHeatmapAssets,
  fallbackHeatmapCollectionId,
  heatmapCollectionLabel,
  heatmapFollowsCollection,
  heatmapTabId,
  isRemoteHeatmapUniverse,
  useLinkedHeatmapCollection,
  type HeatmapBoardAsset,
} from "./portfolio";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import {
  LIVE_STREAMING_QUICK_SETTING,
  useLiveStreamingSetting,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";
import {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";

const NO_ASSETS: HeatmapBoardAsset[] = [];
const NO_BOARD = { assets: NO_ASSETS, omitted: 0 };
const EMPTY_TICKERS: TickerRecord[] = [];
const NO_CURRENCIES: string[] = [];
const EMPTY_TITLE = "No market heatmap data.";
const EMPTY_PORTFOLIO_TITLE = "No symbols in this list.";

function loadCollectionSnapshots(
  tickers: readonly TickerRecord[],
  collectionId: string | null,
  kind: "portfolio" | "watchlist" | null,
  forceRefresh = false,
): void {
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator || !collectionId) return;
  const instrumentOptions = kind === "portfolio" ? { portfolioId: collectionId } : {};
  const instruments = tickers.flatMap((ticker): InstrumentRef[] => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker, instrumentOptions);
    return instrument ? [instrument] : [];
  });
  if (instruments.length > 0) void coordinator.loadSnapshotsBatch(instruments, { forceRefresh }).catch(() => {});
}

function formatMoneyCompact(value: number | null | undefined, currency: string): string {
  if (value == null) return "—";
  if (currency.toUpperCase() === "USD") return `$${formatCompact(value)}`;
  return `${formatCompact(value)} ${currency}`;
}

function sizeLabel(asset: HeatmapBoardAsset): string | null {
  if (asset.showSize === false || asset.size == null) return null;
  const label = asset.sizeCaption ?? (asset.sizeKind === "net-assets" ? "Assets" : "Mkt");
  return `${label} ${formatMoneyCompact(asset.size, asset.sizeCurrency ?? asset.currency)}`;
}

function buildItems(assets: HeatmapBoardAsset[]): Array<MetricTreemapItem<HeatmapBoardAsset>> {
  return assets.map((asset) => ({
    id: asset.symbol,
    label: asset.symbol,
    weight: asset.weight ?? asset.size ?? 0,
    colorValue: asset.hasChange ? asset.changePercent : null,
    // No change data is not a flat session; 0.00% would be a made-up number.
    primaryText: asset.hasChange ? formatPercentRaw(asset.changePercent) : "—",
    secondaryText: sizeLabel(asset),
    tertiaryText: asset.volume != null ? `Vol ${formatCompact(asset.volume)}` : asset.exchange || null,
    data: asset,
  }));
}

/**
 * A tile that clips "$1.0T" into "$1.0" reads as a real, wrong number, so a
 * metric that does not fit its tile is dropped instead of truncated. Layout
 * depends on weights alone, so re-rendering with shorter text keeps the same
 * geometry.
 */
function fitItemsToTiles(
  items: Array<MetricTreemapItem<HeatmapBoardAsset>>,
  tiles: Array<{ item: { id: string }; width: number; height: number }>,
): Array<MetricTreemapItem<HeatmapBoardAsset>> {
  const tileById = new Map(tiles.map((tile) => [tile.item.id, tile]));
  return items.map((item) => {
    const tile = tileById.get(item.id);
    if (!tile) return item;
    // Mirrors the terminal tile's own padding: one cell of border, one of gutter.
    const innerWidth = Math.max(1, Math.floor(tile.width) - (tile.width > 2 ? 1 : 0) - 1);
    const fits = (text: string | null | undefined) => (
      text != null && text.length <= innerWidth ? text : null
    );
    return {
      ...item,
      primaryText: fits(item.primaryText),
      secondaryText: fits(item.secondaryText),
      tertiaryText: fits(item.tertiaryText),
    };
  });
}

function MarketHeatmapPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const liveStreaming = useLiveStreamingSetting();
  const { cellWidthPx = 8, cellHeightPx = 18, nativePaneChrome } = useUiCapabilities();
  // A pane setting, not private pane state, so the settings dialog can show it.
  const [universeSetting, setActiveUniverse] = usePaneSettingValue<string>("universe", "us-equity");
  const [linkPortfolio] = usePaneSettingValue<boolean>("linkPortfolio", false);
  const activeUniverse = heatmapTabId(universeSetting);
  const portfolioTab = activeUniverse === PORTFOLIO_HEATMAP_TAB;
  const config = usePaneAppConfig();
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const linkedPortfolio = useLinkedHeatmapCollection();
  const collectionId = linkedPortfolio.collectionId ?? fallbackHeatmapCollectionId(config);
  const collectionKind = getCollectionTypeFromConfig(config, collectionId);
  const portfolioLabel = heatmapCollectionLabel(config, collectionId);
  const universeTabs = useMemo(() => [
    ...MARKET_HEATMAP_UNIVERSES.map((universe) => ({ label: universe.label, value: universe.id })),
    { label: portfolioLabel, value: PORTFOLIO_HEATMAP_TAB },
  ], [portfolioLabel]);
  const collectionTickers = useMemo(
    () => (portfolioTab && collectionId && collectionKind
      ? getCollectionTickersFromConfig(config, tickersBySymbol, collectionId)
      : EMPTY_TICKERS),
    [collectionId, collectionKind, config, portfolioTab, tickersBySymbol],
  );
  const collectionSymbolsKey = collectionTickers.map((ticker) => ticker.metadata.ticker).join(",");
  const financials = useTickerFinancialsMap(
    collectionTickers,
    collectionKind === "portfolio" && collectionId ? { portfolioId: collectionId } : {},
  );
  // Holdings in the portfolio's currency, as its pane totals them; a watchlist's caps in the base currency.
  const boardCurrency = collectionKind === "portfolio"
    ? resolvePortfolioTotalsCurrency(config.portfolios.find((portfolio) => portfolio.id === collectionId), config.baseCurrency)
    : resolvePortfolioTotalsCurrency(null, config.baseCurrency);
  const trackedCurrencies = useMemo(
    () => (collectionTickers.length > 0
      ? buildTrackedCurrencies(collectionTickers, financials, null, boardCurrency)
      : NO_CURRENCIES),
    [boardCurrency, collectionTickers, financials],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  // Tile areas follow prices on the portfolio pane's reorder cadence, so a
  // tick does not reshuffle the board; colors and captions stream below.
  // A snapshot arriving (the map growing) or a new list applies at once.
  const portfolioBoard = useThrottledMemo(
    () => (collectionId && collectionKind
      ? buildPortfolioHeatmapAssets({
        tickers: collectionTickers,
        financials,
        collectionId,
        kind: collectionKind,
        currency: boardCurrency,
        exchangeRates,
      })
      : NO_BOARD),
    [financials],
    [boardCurrency, collectionId, collectionKind, collectionTickers, exchangeRates, financials.size],
    PORTFOLIO_REORDER_THROTTLE_MS,
  );
  const portfolioAssets = portfolioBoard.assets;
  const [assets, setAssets] = useState<HeatmapBoardAsset[]>([]);
  // The universe `assets` came from. A board is drawn only under its own tab,
  // so a switch never paints the previous universe's tiles.
  const [loadedUniverse, setLoadedUniverse] = useState<MarketHeatmapUniverseId | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // The first load starts before the effect runs; an empty board is not "no data".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const fetchGenRef = useRef(0);
  const seenCollection = useRef<string | null>(null);
  const boardAssets = portfolioTab ? portfolioAssets : (loadedUniverse === activeUniverse ? assets : NO_ASSETS);
  const hasBoard = boardAssets.length > 0;

  const selectUniverse = useCallback((value: string) => {
    setActiveUniverse(heatmapTabId(value));
    setSelectedSymbol(null);
  }, [setActiveUniverse]);
  // The pane's only partition: the desktop draws it in the title bar, which
  // gives the treemap the row the strip used to take.
  const tabsInHeader = usePaneHeaderTabs({
    tabs: universeTabs,
    activeValue: activeUniverse,
    onSelect: selectUniverse,
    focused,
    keyboardNavigation: false,
  });

  const chartHeight = Math.max(1, height - (tabsInHeader ? 0 : 1));
  const chartWidth = Math.max(1, width - 2);
  const cellAspect = Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx)));
  const quoteTargets = useMemo(
    () => buildScreenerQuoteTargets(boardAssets, selectedSymbol),
    [boardAssets, selectedSymbol],
  );
  const {
    entries: liveQuoteEntries,
    freshnessNow,
    subscriptionStartedAt,
  } = useLiveQuoteEntries(quoteTargets, {
    freshnessScopeKey: `market-heatmap:${activeUniverse}`,
    liveStreaming,
  });
  const resolvedAssets = useMemo(
    () => overlayScreenerQuoteEntries(boardAssets, liveQuoteEntries),
    [boardAssets, liveQuoteEntries],
  );
  const feedStatus = useMemo(
    () => resolveScreenerQuoteFeedStatus(quoteTargets, liveQuoteEntries, {
      now: freshnessNow,
      subscriptionStartedAt,
    }),
    [freshnessNow, liveQuoteEntries, quoteTargets, subscriptionStartedAt],
  );
  const items = useMemo(() => buildItems(resolvedAssets), [resolvedAssets]);
  const navigationTiles = useMemo(
    () => buildMetricTreemapNavigationTiles(items, chartWidth, chartHeight, cellAspect, nativePaneChrome ? "float" : "integer"),
    [cellAspect, chartHeight, chartWidth, items, nativePaneChrome],
  );
  // Desktop tiles ellipsize, which is visible; terminal cells clip silently.
  const displayItems = useMemo(
    () => (nativePaneChrome ? items : fitItemsToTiles(items, navigationTiles)),
    [items, nativePaneChrome, navigationTiles],
  );
  const selectedIdx = selectedSymbol
    ? resolvedAssets.findIndex((asset) => asset.symbol === selectedSymbol)
    : -1;
  const activeIdx = selectedIdx >= 0 ? selectedIdx : (resolvedAssets.length > 0 ? 0 : -1);
  const selectedAsset = activeIdx >= 0 ? resolvedAssets[activeIdx] ?? null : null;

  const loadUniverse = useCallback(async (universe: MarketHeatmapUniverseId, options?: { forceRefresh?: boolean }) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setLoadError(null);

    try {
      const result = await fetchMarketHeatmap(universe, {
        count: 96,
        forceRefresh: options?.forceRefresh,
      });
      if (fetchGenRef.current !== gen) return;
      setAssets(result.assets);
      setLoadedUniverse(universe);
      setLastUpdated(result.fetchedAt);
      setStale(result.stale === true);
      // Selection is the user's; the effect below only fills it when it is gone.
    } catch {
      if (fetchGenRef.current !== gen) return;
      // A failed refresh keeps the board it had; the footer says it failed.
      setLoadError(unavailableText("Market heatmap"));
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isRemoteHeatmapUniverse(activeUniverse)) return;
    void loadUniverse(activeUniverse);
  }, [activeUniverse, loadUniverse]);

  useEffect(() => {
    const previous = seenCollection.current;
    seenCollection.current = collectionId;
    if (!heatmapFollowsCollection(linkPortfolio, previous, collectionId)) return;
    setActiveUniverse(PORTFOLIO_HEATMAP_TAB);
    setSelectedSymbol(null);
  }, [collectionId, linkPortfolio, setActiveUniverse]);

  // The financials map only reads the cache; this fills it for the list on screen.
  useEffect(() => {
    if (!portfolioTab) return;
    loadCollectionSnapshots(collectionTickers, collectionId, collectionKind);
    // Keyed by the symbols: another ticker's record changing does not reload the list.
  }, [collectionId, collectionKind, collectionSymbolsKey, portfolioTab]);

  useEffect(() => {
    if (selectedSymbol && boardAssets.some((asset) => asset.symbol === selectedSymbol)) return;
    setSelectedSymbol(boardAssets[0]?.symbol ?? null);
  }, [boardAssets, selectedSymbol]);

  const refresh = useCallback(() => {
    if (portfolioTab) {
      loadCollectionSnapshots(collectionTickers, collectionId, collectionKind, true);
      return;
    }
    if (!isRemoteHeatmapUniverse(activeUniverse)) return;
    void loadUniverse(activeUniverse, { forceRefresh: true });
  }, [activeUniverse, collectionId, collectionKind, collectionTickers, loadUniverse, portfolioTab]);
  // The list's quotes stream; on a timer only the market boards reload.
  const autoRefresh = useCallback(() => {
    if (isRemoteHeatmapUniverse(activeUniverse)) void loadUniverse(activeUniverse, { forceRefresh: true });
  }, [activeUniverse, loadUniverse]);

  const selectAdjacentUniverse = useCallback((direction: -1 | 1) => {
    const index = universeTabs.findIndex((tab) => tab.value === activeUniverse);
    const nextTab = universeTabs[Math.max(0, Math.min(universeTabs.length - 1, index + direction))];
    if (nextTab && nextTab.value !== activeUniverse) {
      setActiveUniverse(nextTab.value);
      setSelectedSymbol(null);
    }
  }, [activeUniverse, setActiveUniverse, universeTabs]);

  const selectUniverseAt = useCallback((index: number) => {
    const tab = universeTabs[index];
    if (!tab || tab.value === activeUniverse) return;
    setActiveUniverse(tab.value);
    setSelectedSymbol(null);
  }, [activeUniverse, setActiveUniverse, universeTabs]);

  const openSymbol = useCallback((symbol: string) => {
    pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const selectIndex = useCallback((index: number) => {
    const asset = boardAssets[index];
    if (asset) setSelectedSymbol(asset.symbol);
  }, [boardAssets]);

  const selectNeighbor = useCallback((direction: MetricTreemapDirection) => {
    const target = findMetricTreemapNeighbor(navigationTiles, selectedSymbol, direction);
    if (target) setSelectedSymbol(target.item.data.symbol);
  }, [navigationTiles, selectedSymbol]);

  useShortcut((event) => {
    if (!focused) return;
    if (handleRefreshKey(event, refresh, { stopPropagation: true })) return;
    if (isPlainKey(event, "1")) {
      event.preventDefault();
      event.stopPropagation();
      selectUniverseAt(0);
      return;
    }
    if (isPlainKey(event, "2")) {
      event.preventDefault();
      event.stopPropagation();
      selectUniverseAt(1);
      return;
    }
    if (isPlainKey(event, "3")) {
      event.preventDefault();
      event.stopPropagation();
      selectUniverseAt(2);
      return;
    }
    if (isPlainKey(event, "[")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentUniverse(-1);
      return;
    }
    if (isPlainKey(event, "]")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentUniverse(1);
      return;
    }
    if (isPlainKey(event, "j")) {
      event.preventDefault();
      event.stopPropagation();
      selectIndex(Math.min((activeIdx >= 0 ? activeIdx : 0) + 1, boardAssets.length - 1));
      return;
    }
    if (isPlainKey(event, "k")) {
      event.preventDefault();
      event.stopPropagation();
      selectIndex(Math.max((activeIdx >= 0 ? activeIdx : 0) - 1, 0));
      return;
    }
    if (isPlainKey(event, "left", "h")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("left");
      return;
    }
    if (isPlainKey(event, "right", "l")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("right");
      return;
    }
    if (isPlainKey(event, "up")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("up");
      return;
    }
    if (isPlainKey(event, "down")) {
      event.preventDefault();
      event.stopPropagation();
      selectNeighbor("down");
      return;
    }
    if (isPlainKey(event, "enter", "return") && selectedAsset) {
      event.preventDefault();
      event.stopPropagation();
      openSymbol(selectedAsset.symbol);
    }
  });

  const updated = useUpdatedAgo(!portfolioTab && loadedUniverse === activeUniverse ? lastUpdated : null);
  useAutoRefresh(lastUpdated, autoRefresh);

  usePaneStatusFooter({ registrationId: "market-heatmap-retained", stale: hasBoard && stale && !portfolioTab });
  usePaneNoticeFooter({
    registrationId: "market-heatmap-omitted",
    notices: portfolioTab && portfolioBoard.omitted > 0
      ? [tf("The {count} smallest names in {list} are left out of the map.", { count: portfolioBoard.omitted, list: portfolioLabel })]
      : [],
    focused,
  });

  usePaneFooter("market-heatmap", () => ({
    info: [
      ...(selectedAsset ? [{
        id: "selected",
        parts: [
          { text: selectedAsset.symbol, tone: "label" as const },
          { text: formatCurrency(selectedAsset.price, selectedAsset.currency), tone: "value" as const },
          {
            text: selectedAsset.hasChange ? formatPercentRaw(selectedAsset.changePercent) : "—",
            tone: "value" as const,
            color: selectedAsset.hasChange ? priceColor(selectedAsset.changePercent) : undefined,
            bold: true,
          },
        ],
      }] : []),
      ...(updated ? [{
        id: "updated",
        parts: [{ text: `updated ${updated}`, tone: "muted" as const }],
      }] : []),
      ...(!portfolioTab && loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      // Without a board the body carries the failure.
      ...(!portfolioTab && loadError && hasBoard ? [{ id: "error", parts: [{ text: "refresh failed", tone: "warning" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
    ],
  }), [feedStatus, hasBoard, loadError, loading, portfolioTab, selectedAsset, updated]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {!tabsInHeader && (
        <Box height={1} paddingX={1}>
          <Tabs
            tabs={universeTabs}
            activeValue={activeUniverse}
            onSelect={selectUniverse}
            compact
            variant="bare"
            focused={focused}
            keyboardNavigation={false}
          />
        </Box>
      )}

      <PaneStatusBody
        loading={!portfolioTab && loading && !hasBoard}
        loadingLabel={loadingText("market heatmap")}
        error={portfolioTab || hasBoard ? null : loadError}
        empty={!hasBoard}
        emptyTitle={portfolioTab ? EMPTY_PORTFOLIO_TITLE : EMPTY_TITLE}
      >
        <MetricTreemapSurface
          items={displayItems}
          width={width}
          height={chartHeight}
          selectedId={selectedSymbol}
          onSelect={(item) => setSelectedSymbol(item.data.symbol)}
          onActivate={(item) => openSymbol(item.data.symbol)}
          emptyStateTitle={portfolioTab ? EMPTY_PORTFOLIO_TITLE : EMPTY_TITLE}
        />
      </PaneStatusBody>
    </Box>
  );
}

export const marketHeatmapPlugin: GloomPlugin = {
  id: "market-heatmap",
  name: "Market Heatmap",
  version: "1.0.0",
  description: "Largest US stocks and ETFs, or the portfolio pane's list, sized by market cap or position and colored by daily move",
  toggleable: true,
  targets: ["cli", "tui", "desktop", "web"],

  dispose() {
    resetMarketHeatmapCache();
  },

  panes: [
    {
      id: "market-heatmap",
      name: "Market Heatmap",
      icon: "H",
      component: MarketHeatmapPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 36 },
      quickSettings: [LIVE_STREAMING_QUICK_SETTING],
      settings: (context) => withLiveStreamingSetting({
        title: "Market Heatmap Settings",
        values: { linkPortfolio: context.settings.linkPortfolio === true },
        fields: [
          {
            key: "universe",
            label: "Universe",
            type: "select",
            options: [
              ...MARKET_HEATMAP_UNIVERSES.map((universe) => ({
                value: universe.id,
                label: universe.label,
              })),
              { value: PORTFOLIO_HEATMAP_TAB, label: "Portfolio pane list" },
            ],
          },
          {
            key: "linkPortfolio",
            label: "Link to portfolio",
            type: "toggle",
            description: "Open the list's tab whenever the portfolio pane switches lists.",
          },
        ] satisfies PaneSettingField[],
      }, context.settings),
    },
  ],

  paneTemplates: [
    {
      id: "market-heatmap-pane",
      paneId: "market-heatmap",
      label: "Market Heatmap",
      description: "Largest US stocks and ETFs, or the portfolio pane's list, sized by market cap or position and colored by daily move.",
      keywords: ["heatmap", "market", "largest", "top", "stocks", "etf", "portfolio", "watchlist", "screener"],
      shortcut: { prefix: "HM" },
    },
  ],
};
