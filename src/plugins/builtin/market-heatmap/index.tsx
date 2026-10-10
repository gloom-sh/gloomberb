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
  type PaneFooterSegment,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useShortcut } from "../../../react/input";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { GloomPlugin, PaneProps, PaneSettingField } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { t, tf } from "../../../i18n";
import { priceColor } from "../../../theme/colors";
import { clipToDisplayWidth, displayWidth, formatCompact, formatCurrency, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { useAppSelector, usePaneAppConfig, usePaneSettingValue, usePaneStateValue } from "../../../state/app/context";
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
  MARKET_HEATMAP_REQUEST_COUNT,
  MARKET_HEATMAP_UNIVERSES,
  fetchMarketHeatmap,
  resetMarketHeatmapCache,
  type MarketHeatmapBoard,
  type MarketHeatmapUniverseId,
} from "./data";
import {
  HEATMAP_COLLECTION_KIND_STATE_KEY,
  PORTFOLIO_HEATMAP_TAB,
  buildPortfolioHeatmapAssets,
  fallbackHeatmapCollectionId,
  heatmapCollectionLabel,
  heatmapFollowsCollection,
  heatmapSizeBy,
  heatmapSizeByApplies,
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
import { useMarketHeatmapEvidence } from "./evidence";
import { marketHeatmapHeadless } from "./headless";
import {
  HEATMAP_NAME_COUNTS,
  heatmapBoardCaption,
  heatmapMove,
  heatmapNameCount,
  heatmapSessionBasis,
  regularSessionHeatmapAssets,
  resolveHeatmapGrouping,
  sizeWeightedMove,
  type HeatmapGrouping,
  type HeatmapSessionBasis,
} from "./model";
import {
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "../../../market-data/quotes/screener-live-quotes";

const NO_ASSETS: HeatmapBoardAsset[] = [];
const NO_TARGETS: QuoteSubscriptionTarget[] = [];
const SNAPSHOT_REFRESH_MS = 60_000;
const LAYOUT_THROTTLE_MS = 5_000;
/** A size change below this share of a tile's area is not worth moving it. */
const LAYOUT_TOLERANCE = 0.005;
const TERMINAL_PAINT_THROTTLE_MS = 250;
/** "loading", which comes and goes with each refresh. */
const LOADING_FOOTER_WIDTH = 7;
const SELECTION_STREAM_SETTLE_MS = 1_500;
const TOOLTIP_NAME_WIDTH = 28;
const SIZE_BY_SETTING_KEY = "sizeBy";
const SQRT_SIZE_VALUE: HeatmapSizeBy = "sqrt-market-cap";
const SESSION_BASIS_SETTING_KEY = "sessionBasis";
const REGULAR_SESSION_BASIS: HeatmapSessionBasis = "regular-session";
const NAME_COUNT_SETTING_KEY = "maxNames";
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

function footerSegmentWidth(segment: PaneFooterSegment): number {
  return segment.parts.reduce((total, part, index) => total + (index > 0 ? 1 : 0) + displayWidth(part.text), 0);
}

function sizeLabel(asset: HeatmapBoardAsset): string | null {
  if (asset.showSize === false || asset.size == null) return null;
  const label = asset.sizeCaption ?? (asset.sizeKind === "net-assets" ? "Assets" : "Mkt");
  return `${label} ${formatMoneyCompact(asset.size, asset.sizeCurrency ?? asset.currency)}`;
}

/** Marks a pre-market or after-hours move, which is measured from the regular close. */
function sessionMark(asset: HeatmapBoardAsset): string | null {
  if (asset.extendedSession === "PRE") return "PM";
  if (asset.extendedSession === "POST") return "AH";
  return null;
}

function formatMove(asset: HeatmapBoardAsset, change: number | null): string {
  const mark = sessionMark(asset);
  return change == null ? "—" : mark ? `${formatPercentRaw(change)} ${mark}` : formatPercentRaw(change);
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
  const change = heatmapMove(asset);
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
    primaryTextSuffix: sessionMark(asset),
    tooltip: [
      [asset.symbol, name, formatMove(asset, change)].filter(Boolean).join(" · "),
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
  const move = sizeWeightedMove(items.map((item) => item.data));
  return [
    tf("Other · {count} smaller names", { count: items.length }),
    ...(move != null ? [`${formatPercentRaw(move)} ${t("cap-weighted")}`] : []),
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
  const [sizeBySetting] = usePaneSettingValue<string>(SIZE_BY_SETTING_KEY, SQRT_SIZE_VALUE);
  const sizeBy = heatmapSizeBy(sizeBySetting);
  const [sessionBasisSetting] = usePaneSettingValue<unknown>(SESSION_BASIS_SETTING_KEY, null);
  const regularSession = heatmapSessionBasis(sessionBasisSetting) === REGULAR_SESSION_BASIS;
  const [nameCountSetting] = usePaneSettingValue<unknown>(NAME_COUNT_SETTING_KEY, null);
  const nameCount = heatmapNameCount(nameCountSetting);
  const activeUniverse = heatmapTabId(universeSetting);
  const portfolioTab = activeUniverse === PORTFOLIO_HEATMAP_TAB;
  const config = usePaneAppConfig();
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const linkedPortfolio = useLinkedHeatmapCollection();
  const collectionId = linkedPortfolio.collectionId ?? fallbackHeatmapCollectionId(config);
  const collectionKind = getCollectionTypeFromConfig(config, collectionId);
  const [, publishCollectionKind] = usePaneStateValue<string>(HEATMAP_COLLECTION_KIND_STATE_KEY, "");
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
        regularSession,
      })
      : NO_BOARD),
    [financials],
    [boardCurrency, collectionId, collectionKind, collectionTickers, exchangeRates, financials.size, regularSession, sizeBy],
    PORTFOLIO_REORDER_THROTTLE_MS,
  );
  const portfolioAssets = portfolioBoard.assets;
  // The last market board that loaded, with the universe and count it was
  // asked for. It is drawn only under its own tab, so a switch never paints the
  // previous universe's tiles, and its footer names its own count while a new
  // one is on its way.
  const [board, setBoard] = useState<MarketHeatmapBoard | null>(null);
  // The first load starts before the effect runs; an empty board is not "no data".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const fetchGenRef = useRef(0);
  const seenCollection = useRef<string | null>(null);
  const shownBoard = !portfolioTab && board?.universe === activeUniverse ? board : null;
  const stale = board?.stale === true;
  const requestCount = isRemoteHeatmapUniverse(activeUniverse)
    ? Math.min(MARKET_HEATMAP_REQUEST_COUNT[activeUniverse], nameCount)
    : 0;
  const marketAssets = useMemo(
    () => {
      const assets: readonly HeatmapBoardAsset[] = shownBoard?.assets ?? NO_ASSETS;
      return regularSession ? regularSessionHeatmapAssets(assets, shownBoard?.session) : assets;
    },
    [regularSession, shownBoard],
  );
  const boardAssets = portfolioTab ? portfolioAssets : marketAssets;
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
  const completedSessionDate = shownBoard?.regularSessionDate ?? null;
  const resolvedAssets = useMemo(
    () => overlayScreenerQuoteEntries(boardAssets, liveQuoteEntries, regularSession
      ? { regularSession: true, completedSessionDate }
      : { extendedSessions: true }),
    [boardAssets, completedSessionDate, liveQuoteEntries, regularSession],
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
    () => resolveHeatmapGrouping(boardAssets, activeUniverse === "us-equity"),
    [activeUniverse, boardAssets],
  );
  // A new board, or a new Colour by, applies at once rather than on the next tick.
  const layoutAssets = useThrottledMemo(
    () => resolvedAssets,
    [resolvedAssets],
    [boardAssets, regularSession],
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
    [boardAssets, regularSession],
    nativePaneChrome ? 0 : TERMINAL_PAINT_THROTTLE_MS,
  );
  const paintItems = useMemo(() => buildPaintItems(paintAssets), [paintAssets]);
  const visibleTiles = scene.tiles;
  useMarketHeatmapEvidence({
    tab: activeUniverse,
    tiles: visibleTiles,
    assets: paintAssets,
    grouped: grouping !== "flat",
    loading: !portfolioTab && loading,
    retained: !portfolioTab && (stale || loadError != null),
  });
  const selectedTileIndex = selectedSymbol ? visibleTiles.findIndex((tile) => tile.item.id === selectedSymbol) : -1;
  const activeIdx = selectedTileIndex >= 0 ? selectedTileIndex : (visibleTiles.length > 0 ? 0 : -1);
  const activeSymbol = activeIdx >= 0 ? visibleTiles[activeIdx]!.item.id : null;
  const selectedAsset = activeSymbol
    ? resolvedAssets.find((asset) => asset.symbol === activeSymbol) ?? null
    : null;

  const loadUniverse = useCallback(async (universe: MarketHeatmapUniverseId, count: number, options?: { forceRefresh?: boolean }) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setLoadError(null);

    try {
      const result = await fetchMarketHeatmap(universe, {
        count,
        forceRefresh: options?.forceRefresh,
      });
      if (fetchGenRef.current !== gen) return;
      setBoard(result);
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
    void loadUniverse(activeUniverse, requestCount);
  }, [activeUniverse, loadUniverse, requestCount]);

  useEffect(() => {
    const previous = seenCollection.current;
    seenCollection.current = collectionId;
    if (!heatmapFollowsCollection(linkPortfolio, previous, collectionId)) return;
    setActiveUniverse(PORTFOLIO_HEATMAP_TAB);
    setSelectedSymbol(null);
  }, [collectionId, linkPortfolio, setActiveUniverse]);

  // The header shows the square-root control only where it changes the board.
  useEffect(() => {
    publishCollectionKind(collectionKind ?? "");
  }, [collectionKind, publishCollectionKind]);

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
    void loadUniverse(activeUniverse, requestCount, { forceRefresh: true });
  }, [activeUniverse, collectionId, collectionKind, collectionTickers, loadUniverse, portfolioTab, requestCount]);
  // The list's quotes stream; on a timer only the market boards reload.
  const autoRefresh = useCallback(() => {
    if (isRemoteHeatmapUniverse(activeUniverse)) void loadUniverse(activeUniverse, requestCount, { forceRefresh: true });
  }, [activeUniverse, loadUniverse, requestCount]);

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

  // Ages the last check that succeeded, not the snapshot, which the server can
  // hand back unchanged long after it was put together.
  const checked = useUpdatedAgo(shownBoard?.checkedAt ?? null);
  // The snapshot carries sizes and every name the stream does not; the server caches it for a minute.
  useAutoRefresh(board?.checkedAt ?? null, autoRefresh, { intervalMs: SNAPSHOT_REFRESH_MS });

  usePaneStatusFooter({ registrationId: "market-heatmap-retained", stale: hasBoard && stale && !portfolioTab });
  usePaneNoticeFooter({
    registrationId: "market-heatmap-omitted",
    notices: portfolioTab && portfolioBoard.omitted > 0
      ? [tf("The {count} smallest names in {list} are left out of the map.", { count: portfolioBoard.omitted, list: portfolioLabel })]
      : [],
    focused,
  });

  usePaneFooter("market-heatmap", () => {
    const selected: PaneFooterSegment[] = selectedAsset ? [{
      id: "selected",
      parts: [
        { text: selectedAsset.symbol, tone: "label" as const },
        {
          text: heatmapMove(selectedAsset) == null ? "—" : formatPercentRaw(heatmapMove(selectedAsset)!),
          tone: "value" as const,
          color: heatmapMove(selectedAsset) == null ? undefined : priceColor(heatmapMove(selectedAsset)!),
          bold: true,
        },
        ...(sessionMark(selectedAsset) ? [{ text: sessionMark(selectedAsset)!, tone: "muted" as const }] : []),
        ...(selectedAsset.price > 0
          ? [{ text: formatCurrency(selectedAsset.price, selectedAsset.currency), tone: "value" as const }]
          : []),
        ...(sizeLabel(selectedAsset) ? [{ text: sizeLabel(selectedAsset)!, tone: "muted" as const }] : []),
        ...(selectedAsset.volume != null
          ? [{ text: `Vol ${formatCompact(selectedAsset.volume)}`, tone: "muted" as const }]
          : []),
      ],
    }] : [];
    // Without a board the body carries the failure.
    const failed: PaneFooterSegment[] = !portfolioTab && loadError && hasBoard
      ? [{ id: "error", parts: [{ text: "refresh failed", tone: "warning" as const }] }]
      : [];
    const feed: PaneFooterSegment[] = feedStatus
      ? [{ id: "feed", parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }] }]
      : [];
    const loadingSegment: PaneFooterSegment[] = !portfolioTab && loading
      ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }]
      : [];
    // The caption takes the room the rest leaves, with "loading" counted in
    // always, so a refresh never squeezes the row; a narrow pane drops its
    // least important parts rather than truncating every segment.
    const others = [...selected, ...failed, ...feed];
    const room = width - others.reduce((total, segment) => total + footerSegmentWidth(segment) + 1, 0) - LOADING_FOOTER_WIDTH - 1;
    const caption = shownBoard ? heatmapBoardCaption(shownBoard, { now: Date.now(), checked, failed: failed.length > 0, maxWidth: room }) : null;
    return {
      info: [
        ...selected,
        ...failed,
        ...(caption ? [{ id: "board", parts: [{ text: caption, tone: "muted" as const }] }] : []),
        ...feed,
        ...loadingSegment,
      ],
    };
  }, [checked, feedStatus, hasBoard, loadError, loading, portfolioTab, selectedAsset, shownBoard, width]);

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
  description: "Largest US stocks and ETFs, or the portfolio pane's list, sized by the square root of market cap or by position value and colored by daily move",
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
      headless: marketHeatmapHeadless,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 36 },
      quickSettings: [
        LIVE_STREAMING_QUICK_SETTING,
        {
          type: "toggle",
          key: SIZE_BY_SETTING_KEY,
          icon: "sqrt",
          onValue: SQRT_SIZE_VALUE,
          label: "Size by square root of market cap",
          visible: (context) => heatmapSizeByApplies(context.settings.universe, context.paneState[HEATMAP_COLLECTION_KIND_STATE_KEY]),
        },
      ],
      settings: (context) => withLiveStreamingSetting({
        title: "Market Heatmap Settings",
        values: {
          linkPortfolio: context.settings.linkPortfolio === true,
          [SIZE_BY_SETTING_KEY]: heatmapSizeBy(context.settings[SIZE_BY_SETTING_KEY]),
          [SESSION_BASIS_SETTING_KEY]: heatmapSessionBasis(context.settings[SESSION_BASIS_SETTING_KEY]),
          [NAME_COUNT_SETTING_KEY]: String(heatmapNameCount(context.settings[NAME_COUNT_SETTING_KEY])),
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
            description: "Square root gives mid-size names room next to the largest. A portfolio is always sized by position value.",
          },
          {
            key: SESSION_BASIS_SETTING_KEY,
            label: "Colour by",
            type: "select",
            options: [
              { value: REGULAR_SESSION_BASIS, label: "Regular session" },
              { value: "active-session", label: "Active session" },
            ],
            description: "Active session follows pre-market and after-hours trading. Regular session shows the regular session alone: its move while it trades, then its close and move until the next one opens.",
          },
          {
            key: NAME_COUNT_SETTING_KEY,
            label: "Names",
            type: "select",
            options: HEATMAP_NAME_COUNTS.map((count) => ({ value: String(count), label: `Top ${count}` })),
            description: "How many of the largest names US Stocks draws, and US ETFs up to 160. Fewer names leave fewer in Other.",
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
      description: "Largest US stocks and ETFs, or the portfolio pane's list, sized by the square root of market cap or by position value and colored by daily move.",
      keywords: ["heatmap", "market", "largest", "top", "stocks", "etf", "portfolio", "watchlist", "screener"],
      shortcut: { prefix: "HM" },
    },
  ],
};
