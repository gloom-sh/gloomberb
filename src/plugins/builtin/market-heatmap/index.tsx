import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useUiCapabilities } from "../../../ui";
import {
  buildHeatTreemapScene,
  findMetricTreemapNeighbor,
  formatHeatTileMove,
  heatTreemapCanvas,
  HeatTreemapSurface,
  settleTreemapLayoutItems,
} from "../../../components/metric-treemap";
import {
  loadingText,
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
import { t, tf } from "../../../i18n";
import { priceColor } from "../../../theme/colors";
import { clipToDisplayWidth, formatCompact, formatCurrency, formatPercentRaw } from "../../../utils/format";
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
  heatmapSizeBy,
  heatmapSizeWeight,
  heatmapTabId,
  isRemoteHeatmapUniverse,
  useLinkedHeatmapCollection,
  type HeatmapBoardAsset,
  type HeatmapSizeBy,
} from "./portfolio";
import { useAutoRefresh, useUpdatedAgo } from "../../../react/auto-refresh";
import {
  LIVE_STREAMING_QUICK_SETTING,
  useLiveStreamingSetting,
  withLiveStreamingSetting,
} from "../../../state/hooks/live-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import {
  buildHeatmapQuoteTargets,
  liveHeatmapWeight,
  rankHeatmapQuoteWeights,
  useSettledValue,
} from "./live";
import {
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";

const NO_ASSETS: HeatmapBoardAsset[] = [];
const NO_TARGETS: QuoteSubscriptionTarget[] = [];
/** The 500 largest US stocks (an older server answers with its own maximum); ETFs stay flat and need fewer. */
const MARKET_HEATMAP_REQUEST_COUNT: Record<MarketHeatmapUniverseId, number> = { "us-equity": 500, "us-etf": 160 };
const SNAPSHOT_REFRESH_MS = 60_000;
const LAYOUT_THROTTLE_MS = 5_000;
/** A size change below this share of a tile's area is not worth moving it. */
const LAYOUT_TOLERANCE = 0.005;
const TERMINAL_PAINT_THROTTLE_MS = 250;
const SELECTION_STREAM_SETTLE_MS = 1_500;
const TOOLTIP_NAME_WIDTH = 28;
const SIZE_BY_SETTING_KEY = "sizeBy";
const SQRT_SIZE_VALUE: HeatmapSizeBy = "sqrt-market-cap";
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

/** The move, or null when there is none: no change data is not a flat session. */
function changeOf(asset: HeatmapBoardAsset): number | null {
  return asset.hasChange && typeof asset.changePercent === "number" && Number.isFinite(asset.changePercent)
    ? asset.changePercent
    : null;
}

type HeatmapGrouping = "sector-industry" | "sector" | "flat";

/**
 * Sector and industry blocks when the board knows its sectors. A board where
 * most of the value has none (ETFs, or a snapshot whose classification
 * failed) lays out flat rather than as one big unlabeled block.
 */
function resolveGrouping(assets: readonly HeatmapBoardAsset[], industries: boolean): HeatmapGrouping {
  let total = 0;
  let classified = 0;
  const sectors = new Set<string>();
  for (const asset of assets) {
    const weight = asset.weight ?? asset.size ?? 0;
    total += weight;
    if (asset.sector) {
      classified += weight;
      sectors.add(asset.sector);
    }
  }
  if (sectors.size < 2 || classified < total / 2) return "flat";
  return industries ? "sector-industry" : "sector";
}

/**
 * The size transform applies to each name before groups sum them, so a
 * sector's block is the sum of its transformed names. A board that already
 * carries a weight (a portfolio or watchlist) applied it when it was built.
 */
function buildLayoutItems(
  snapshot: readonly HeatmapBoardAsset[],
  live: readonly HeatmapBoardAsset[],
  grouping: HeatmapGrouping,
  sizeBy: HeatmapSizeBy,
): Array<MetricTreemapItem<HeatmapBoardAsset>> {
  return snapshot.map((asset, index) => ({
    id: asset.symbol,
    label: asset.symbol,
    weight: asset.weight != null
      ? liveHeatmapWeight(asset, live[index] ?? asset)
      : heatmapSizeWeight(liveHeatmapWeight(asset, live[index] ?? asset), sizeBy),
    group: grouping === "flat" ? undefined : asset.sector ?? null,
    subgroup: grouping === "sector-industry" ? asset.industry ?? null : undefined,
    data: asset,
  }));
}

/**
 * The overlay hands back the same asset object while its quote is unchanged,
 * so a tile's text is formatted once per tick of that name, not once per
 * frame for all 500.
 */
const paintItemCache = new WeakMap<HeatmapBoardAsset, MetricTreemapItem<HeatmapBoardAsset>>();

function paintItem(asset: HeatmapBoardAsset): MetricTreemapItem<HeatmapBoardAsset> {
  const cached = paintItemCache.get(asset);
  if (cached) return cached;
  const change = changeOf(asset);
  const details = [
    asset.price > 0 ? formatCurrency(asset.price, asset.currency) : null,
    sizeLabel(asset),
    asset.volume != null ? `Vol ${formatCompact(asset.volume)}` : null,
  ].filter((part): part is string => !!part);
  // The move closes the line, so a long name gives way instead of hiding it.
  const name = asset.name && asset.name !== asset.symbol ? clipToDisplayWidth(asset.name, TOOLTIP_NAME_WIDTH) : null;
  const item: MetricTreemapItem<HeatmapBoardAsset> = {
    id: asset.symbol,
    label: asset.symbol,
    weight: asset.weight ?? asset.size ?? 0,
    colorValue: change,
    primaryText: formatHeatTileMove(change),
    tooltip: [
      [asset.symbol, name, change == null ? "—" : formatPercentRaw(change)].filter(Boolean).join(" · "),
      ...(details.length > 0 ? [details.join(" · ")] : []),
    ],
    data: asset,
  };
  paintItemCache.set(asset, item);
  return item;
}

function buildPaintItems(assets: readonly HeatmapBoardAsset[]): Array<MetricTreemapItem<HeatmapBoardAsset>> {
  return assets.map(paintItem);
}

function otherSummary(items: readonly MetricTreemapItem<HeatmapBoardAsset>[]): string {
  return tf("{count} names", { count: items.length });
}

function otherTooltip(items: readonly MetricTreemapItem<HeatmapBoardAsset>[]): string[] {
  let weight = 0;
  let weightedMove = 0;
  for (const item of items) {
    const change = changeOf(item.data);
    const size = item.data.size ?? 0;
    if (change == null || !(size > 0)) continue;
    weight += size;
    weightedMove += change * size;
  }
  return [
    tf("Other · {count} smaller names", { count: items.length }),
    ...(weight > 0 ? [`${formatPercentRaw(weightedMove / weight)} ${t("cap-weighted")}`] : []),
  ];
}

function useSettledLayoutItems<T>(items: readonly MetricTreemapItem<T>[]): readonly MetricTreemapItem<T>[] {
  const settledRef = useRef<readonly MetricTreemapItem<T>[] | null>(null);
  const settled = settleTreemapLayoutItems(settledRef.current, items, LAYOUT_TOLERANCE);
  settledRef.current = settled;
  return settled;
}

function MarketHeatmapPane({ focused, width, height }: PaneProps) {
  const { pinTicker } = usePluginTickerActions();
  const liveStreaming = useLiveStreamingSetting();
  const { cellWidthPx = 8, cellHeightPx = 18, nativePaneChrome } = useUiCapabilities();
  // A pane setting, not private pane state, so the settings dialog can show it.
  const [universeSetting, setActiveUniverse] = usePaneSettingValue<string>("universe", "us-equity");
  const [linkPortfolio] = usePaneSettingValue<boolean>("linkPortfolio", false);
  const [sizeBySetting] = usePaneSettingValue<string>(SIZE_BY_SETTING_KEY, "market-cap");
  const sizeBy = heatmapSizeBy(sizeBySetting);
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
        sizeBy,
      })
      : NO_BOARD),
    [financials],
    [boardCurrency, collectionId, collectionKind, collectionTickers, exchangeRates, financials.size, sizeBy],
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
  const canvas = useMemo(
    () => heatTreemapCanvas(width, chartHeight, { nativePaneChrome, cellWidthPx, cellHeightPx }),
    [cellHeightPx, cellWidthPx, chartHeight, nativePaneChrome, width],
  );

  // Stream weights by market-cap rank, fixed for this load of the board.
  const quoteWeightsRef = useRef<{ tab: string; weights: Map<string, number> } | null>(null);
  const quoteWeights = useMemo(() => {
    const previous = quoteWeightsRef.current?.tab === activeUniverse ? quoteWeightsRef.current.weights : null;
    const weights = rankHeatmapQuoteWeights(boardAssets, previous);
    quoteWeightsRef.current = { tab: activeUniverse, weights };
    return weights;
  }, [activeUniverse, boardAssets]);
  const streamSelection = useSettledValue(selectedSymbol, SELECTION_STREAM_SETTLE_MS);
  // With streaming off the board refreshes from snapshots only: no 500-name poll on top of them.
  const quoteTargets = useMemo(
    () => (liveStreaming ? buildHeatmapQuoteTargets(boardAssets, quoteWeights, streamSelection) : NO_TARGETS),
    [boardAssets, liveStreaming, quoteWeights, streamSelection],
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

  // Sizes follow live prices at most every LAYOUT_THROTTLE_MS and only past
  // LAYOUT_TOLERANCE; a new snapshot relays out at once. Ticks only recolour.
  const grouping = useMemo(
    () => resolveGrouping(boardAssets, activeUniverse === "us-equity"),
    [activeUniverse, boardAssets],
  );
  const layoutAssets = useThrottledMemo(
    () => resolvedAssets,
    [resolvedAssets],
    [boardAssets],
    LAYOUT_THROTTLE_MS,
  );
  const layoutItems = useSettledLayoutItems(
    useMemo(() => buildLayoutItems(boardAssets, layoutAssets, grouping, sizeBy), [boardAssets, grouping, layoutAssets, sizeBy]),
  );
  // The board on screen seeds the next layout's order, so a refresh nudges tiles instead of reshuffling them.
  const sceneRef = useRef<{ tab: string; scene: ReturnType<typeof buildHeatTreemapScene<HeatmapBoardAsset>> } | null>(null);
  const scene = useMemo(() => {
    const previous = sceneRef.current?.tab === activeUniverse ? sceneRef.current.scene : null;
    const next = buildHeatTreemapScene(layoutItems, canvas, previous);
    sceneRef.current = { tab: activeUniverse, scene: next };
    return next;
  }, [activeUniverse, canvas, layoutItems]);
  // The terminal repaints whole cells: colours there move at most four times a second.
  const paintAssets = useThrottledMemo(
    () => resolvedAssets,
    [resolvedAssets],
    [boardAssets],
    nativePaneChrome ? 0 : TERMINAL_PAINT_THROTTLE_MS,
  );
  const paintItems = useMemo(() => buildPaintItems(paintAssets), [paintAssets]);
  const visibleTiles = scene.tiles;
  const selectedTileIndex = selectedSymbol ? visibleTiles.findIndex((tile) => tile.item.id === selectedSymbol) : -1;
  const activeIdx = selectedTileIndex >= 0 ? selectedTileIndex : (visibleTiles.length > 0 ? 0 : -1);
  const activeSymbol = activeIdx >= 0 ? visibleTiles[activeIdx]!.item.id : null;
  const selectedAsset = activeSymbol
    ? resolvedAssets.find((asset) => asset.symbol === activeSymbol) ?? null
    : null;

  const loadUniverse = useCallback(async (universe: MarketHeatmapUniverseId, options?: { forceRefresh?: boolean }) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setLoadError(null);

    try {
      const result = await fetchMarketHeatmap(universe, {
        count: MARKET_HEATMAP_REQUEST_COUNT[universe],
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

  // Only drawn tiles are selectable; a name folded into Other hands the selection to the first tile.
  useEffect(() => {
    if (selectedSymbol && visibleTiles.some((tile) => tile.item.id === selectedSymbol)) return;
    const first = visibleTiles[0]?.item.id ?? null;
    if (first !== selectedSymbol) setSelectedSymbol(first);
  }, [selectedSymbol, visibleTiles]);

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

  // j and k walk the tiles in reading order: sector by sector, largest first.
  const selectIndex = useCallback((index: number) => {
    const tile = visibleTiles[index];
    if (tile) setSelectedSymbol(tile.item.id);
  }, [visibleTiles]);

  const selectNeighbor = useCallback((direction: MetricTreemapDirection) => {
    const target = findMetricTreemapNeighbor(visibleTiles, activeSymbol, direction);
    if (target) setSelectedSymbol(target.item.id);
  }, [activeSymbol, visibleTiles]);

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
      selectIndex(Math.min((activeIdx >= 0 ? activeIdx : 0) + 1, visibleTiles.length - 1));
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
  // The snapshot carries sizes and every name the stream does not; the server caches it for a minute.
  useAutoRefresh(lastUpdated, autoRefresh, { intervalMs: SNAPSHOT_REFRESH_MS });

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
          {
            text: changeOf(selectedAsset) == null ? "—" : formatPercentRaw(changeOf(selectedAsset)!),
            tone: "value" as const,
            color: changeOf(selectedAsset) == null ? undefined : priceColor(changeOf(selectedAsset)!),
            bold: true,
          },
          ...(selectedAsset.price > 0
            ? [{ text: formatCurrency(selectedAsset.price, selectedAsset.currency), tone: "value" as const }]
            : []),
          ...(sizeLabel(selectedAsset) ? [{ text: sizeLabel(selectedAsset)!, tone: "muted" as const }] : []),
          ...(selectedAsset.volume != null
            ? [{ text: `Vol ${formatCompact(selectedAsset.volume)}`, tone: "muted" as const }]
            : []),
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
        <HeatTreemapSurface
          scene={scene}
          items={paintItems}
          width={width}
          height={chartHeight}
          selectedId={activeSymbol}
          onSelect={(item) => setSelectedSymbol(item.id)}
          onActivate={(item) => openSymbol(item.id)}
          emptyStateTitle={portfolioTab ? EMPTY_PORTFOLIO_TITLE : EMPTY_TITLE}
          otherTooltip={otherTooltip}
          otherSummary={otherSummary}
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
      quickSettings: [
        LIVE_STREAMING_QUICK_SETTING,
        { type: "toggle", key: SIZE_BY_SETTING_KEY, icon: "sqrt", onValue: SQRT_SIZE_VALUE, label: "Size by square root of market cap" },
      ],
      settings: (context) => withLiveStreamingSetting({
        title: "Market Heatmap Settings",
        values: {
          linkPortfolio: context.settings.linkPortfolio === true,
          [SIZE_BY_SETTING_KEY]: heatmapSizeBy(context.settings[SIZE_BY_SETTING_KEY]),
        },
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
            key: SIZE_BY_SETTING_KEY,
            label: "Size by",
            type: "select",
            options: [
              { value: "market-cap", label: "Market cap" },
              { value: SQRT_SIZE_VALUE, label: "Square root of market cap" },
            ],
            description: "Square root gives mid-size names room next to the largest. Portfolios apply it to position value.",
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
