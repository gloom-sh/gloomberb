import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useUiCapabilities } from "../../../ui";
import {
  buildMetricTreemapNavigationTiles,
  findMetricTreemapNeighbor,
  MetricTreemapSurface,
  Tabs,
  usePaneFooter,
  type MetricTreemapDirection,
  type MetricTreemapItem,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { priceColor } from "../../../theme/colors";
import { formatCompact, formatCurrency, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { usePaneSettingValue } from "../../../state/app/context";
import { usePluginTickerActions } from "../../runtime";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import {
  MARKET_HEATMAP_UNIVERSES,
  fetchMarketHeatmap,
  resetMarketHeatmapCache,
  type MarketHeatmapAsset,
  type MarketHeatmapUniverseId,
} from "./data";
import { useAutoRefresh, useUpdatedAgo } from "../shared/auto-refresh";
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

function formatMoneyCompact(value: number | null | undefined, currency: string): string {
  if (value == null) return "—";
  if (currency.toUpperCase() === "USD") return `$${formatCompact(value)}`;
  return `${formatCompact(value)} ${currency}`;
}

function sizeLabel(asset: MarketHeatmapAsset): string | null {
  if (asset.size == null) return null;
  const label = asset.sizeKind === "net-assets" ? "Assets" : "Mkt";
  return `${label} ${formatMoneyCompact(asset.size, asset.currency)}`;
}

function buildItems(assets: MarketHeatmapAsset[]): Array<MetricTreemapItem<MarketHeatmapAsset>> {
  return assets.map((asset) => ({
    id: asset.symbol,
    label: asset.symbol,
    weight: asset.size ?? 0,
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
  items: Array<MetricTreemapItem<MarketHeatmapAsset>>,
  tiles: Array<{ item: { id: string }; width: number; height: number }>,
): Array<MetricTreemapItem<MarketHeatmapAsset>> {
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
  const [activeUniverse, setActiveUniverse] = usePaneSettingValue<MarketHeatmapUniverseId>("universe", "us-equity");
  const [assets, setAssets] = useState<MarketHeatmapAsset[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // The first load starts before the effect runs; an empty board is not "no data".
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const fetchGenRef = useRef(0);

  const chartHeight = Math.max(1, height - 1);
  const chartWidth = Math.max(1, width - 2);
  const cellAspect = Math.max(0.5, Math.min(4, cellHeightPx / Math.max(1, cellWidthPx)));
  const quoteTargets = useMemo(
    () => buildScreenerQuoteTargets(assets, selectedSymbol),
    [assets, selectedSymbol],
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
    () => overlayScreenerQuoteEntries(assets, liveQuoteEntries),
    [assets, liveQuoteEntries],
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
      setLastUpdated(result.fetchedAt);
      // Selection is the user's; the effect below only fills it when it is gone.
    } catch {
      if (fetchGenRef.current !== gen) return;
      setAssets([]);
      setLastUpdated(null);
      setSelectedSymbol(null);
      setLoadError("Market heatmap temporarily unavailable");
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUniverse(activeUniverse);
  }, [activeUniverse, loadUniverse]);

  useEffect(() => {
    if (selectedSymbol && assets.some((asset) => asset.symbol === selectedSymbol)) return;
    setSelectedSymbol(assets[0]?.symbol ?? null);
  }, [assets, selectedSymbol]);

  const refresh = useCallback(() => {
    void loadUniverse(activeUniverse, { forceRefresh: true });
  }, [activeUniverse, loadUniverse]);

  const selectAdjacentUniverse = useCallback((direction: -1 | 1) => {
    const index = MARKET_HEATMAP_UNIVERSES.findIndex((universe) => universe.id === activeUniverse);
    const nextUniverse = MARKET_HEATMAP_UNIVERSES[Math.max(0, Math.min(MARKET_HEATMAP_UNIVERSES.length - 1, index + direction))];
    if (nextUniverse && nextUniverse.id !== activeUniverse) {
      setActiveUniverse(nextUniverse.id);
      setSelectedSymbol(null);
    }
  }, [activeUniverse, setActiveUniverse]);

  const selectUniverseAt = useCallback((index: number) => {
    const universe = MARKET_HEATMAP_UNIVERSES[index];
    if (!universe || universe.id === activeUniverse) return;
    setActiveUniverse(universe.id);
    setSelectedSymbol(null);
  }, [activeUniverse, setActiveUniverse]);

  const openSymbol = useCallback((symbol: string) => {
    pinTicker(symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [pinTicker]);

  const selectIndex = useCallback((index: number) => {
    const asset = assets[index];
    if (asset) setSelectedSymbol(asset.symbol);
  }, [assets]);

  const selectNeighbor = useCallback((direction: MetricTreemapDirection) => {
    const target = findMetricTreemapNeighbor(navigationTiles, selectedSymbol, direction);
    if (target) setSelectedSymbol(target.item.data.symbol);
  }, [navigationTiles, selectedSymbol]);

  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "r")) {
      event.preventDefault();
      event.stopPropagation();
      refresh();
      return;
    }
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
      selectIndex(Math.min((activeIdx >= 0 ? activeIdx : 0) + 1, assets.length - 1));
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

  const updated = useUpdatedAgo(lastUpdated);
  useAutoRefresh(lastUpdated, refresh);

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
      ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(loadError ? [{ id: "error", parts: [{ text: "error", tone: "muted" as const }] }] : []),
      ...(feedStatus ? [{
        id: "feed",
        parts: [{ text: feedStatus, tone: feedStatus === "live" ? "value" as const : "muted" as const }],
      }] : []),
    ],
  }), [feedStatus, loadError, loading, selectedAsset, updated]);

  const emptyStateTitle = loading
    ? "Loading market heatmap..."
    : loadError ?? "No market heatmap data";

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={MARKET_HEATMAP_UNIVERSES.map((universe) => ({ label: universe.label, value: universe.id }))}
          activeValue={activeUniverse}
          onSelect={(value) => {
            setActiveUniverse(value as MarketHeatmapUniverseId);
            setSelectedSymbol(null);
          }}
          compact
          variant="bare"
          focused={focused}
          keyboardNavigation={false}
        />
      </Box>

      <MetricTreemapSurface
        items={displayItems}
        width={width}
        height={chartHeight}
        selectedId={selectedSymbol}
        onSelect={(item) => setSelectedSymbol(item.data.symbol)}
        onActivate={(item) => openSymbol(item.data.symbol)}
        emptyStateTitle={emptyStateTitle}
      />
    </Box>
  );
}

export const marketHeatmapModule: PluginModule = {
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
        fields: [{
          key: "universe",
          label: "Universe",
          type: "select",
          options: MARKET_HEATMAP_UNIVERSES.map((universe) => ({
            value: universe.id,
            label: universe.label,
          })),
        }],
      }, context.settings),
    },
  ],

  paneTemplates: [
    {
      id: "market-heatmap-pane",
      paneId: "market-heatmap",
      label: "Market Heatmap",
      description: "Largest US stocks and ETFs, sized by market cap or assets and colored by daily move.",
      keywords: ["heatmap", "market", "largest", "top", "stocks", "etf", "screener"],
      shortcut: { prefix: "HM" },
    },
  ],
};
