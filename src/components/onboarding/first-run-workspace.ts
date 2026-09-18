import {
  CHART_COMPOSER_PANE_ID,
  DEFAULT_COLUMNS,
  DEFAULT_PORTFOLIO_COLUMN_IDS,
  type AppConfig,
  type LayoutConfig,
  type PaneInstanceConfig,
  type SavedLayout,
} from "../../types/config";
import type { TickerMetadata, TickerRecord } from "../../types/ticker";

/**
 * The watchlist a first run lands with: the two index ETFs and the names most
 * people recognize, capped so the pane reads at a glance. Startup already
 * seeds a longer default list; this trims it to the cap and drops anything
 * the user holds, since holdings live in the heatmap next to it.
 */
export const FIRST_RUN_WATCHLIST: ReadonlyArray<Pick<TickerMetadata, "ticker" | "name" | "exchange" | "assetCategory">> = [
  { ticker: "SPY", name: "SPDR S&P 500 ETF", exchange: "NYSEARCA", assetCategory: "ETF" },
  { ticker: "QQQ", name: "Invesco QQQ Trust", exchange: "NASDAQ", assetCategory: "ETF" },
  { ticker: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", assetCategory: "STK" },
  { ticker: "MSFT", name: "Microsoft Corp.", exchange: "NASDAQ", assetCategory: "STK" },
  { ticker: "NVDA", name: "NVIDIA Corp.", exchange: "NASDAQ", assetCategory: "STK" },
  { ticker: "AMZN", name: "Amazon.com Inc.", exchange: "NASDAQ", assetCategory: "STK" },
  { ticker: "TSLA", name: "Tesla Inc.", exchange: "NASDAQ", assetCategory: "STK" },
];
export const FIRST_RUN_WATCHLIST_SIZE = 7;

export const FIRST_RUN_PANE_IDS = {
  heatmap: "portfolio-list:home-heatmap",
  watchlist: "portfolio-list:home-watchlist",
  chart: "chart-composer:home",
  news: "ticker-news:home",
  indices: "world-indices:home",
  sentiment: "fear-greed:home",
} as const;

export interface FirstRunWatchlistPlan {
  /** Tickers that do not exist yet and should be created in the watchlist. */
  create: TickerMetadata[];
  /** Existing tickers whose watchlist membership changes (joined or left). */
  update: TickerRecord[];
}

/**
 * What the watchlist should contain: the preferred names first, then whatever
 * the startup seed left, minus holdings, capped. Returns the writes needed to
 * get there so the caller persists exactly those.
 */
export function planFirstRunWatchlist(
  tickers: ReadonlyMap<string, TickerRecord>,
  watchlistId: string,
  portfolioId: string,
): FirstRunWatchlistPlan {
  const held = (symbol: string) => {
    const ticker = tickers.get(symbol);
    return !!ticker && (ticker.metadata.portfolios.includes(portfolioId)
      || ticker.metadata.positions.some((position) => position.portfolio === portfolioId));
  };
  const preferred = FIRST_RUN_WATCHLIST.map((seed) => seed.ticker);
  const seeded = [...tickers.values()]
    .filter((ticker) => ticker.metadata.watchlists.includes(watchlistId))
    .map((ticker) => ticker.metadata.ticker);
  const keep = new Set<string>();
  for (const symbol of [...preferred, ...seeded]) {
    if (keep.size >= FIRST_RUN_WATCHLIST_SIZE) break;
    if (!held(symbol)) keep.add(symbol);
  }

  const create = FIRST_RUN_WATCHLIST
    .filter((seed) => keep.has(seed.ticker) && !tickers.has(seed.ticker))
    .map((seed) => ({
      ticker: seed.ticker,
      name: seed.name,
      exchange: seed.exchange,
      currency: "USD",
      assetCategory: seed.assetCategory,
      portfolios: [],
      watchlists: [watchlistId],
      positions: [],
      custom: {},
      tags: [],
    }));
  const update: TickerRecord[] = [];
  for (const ticker of tickers.values()) {
    const symbol = ticker.metadata.ticker;
    const listed = ticker.metadata.watchlists.includes(watchlistId);
    if (keep.has(symbol) && !listed) {
      update.push({ ...ticker, metadata: { ...ticker.metadata, watchlists: [...ticker.metadata.watchlists, watchlistId] } });
    } else if (!keep.has(symbol) && listed) {
      update.push({ ...ticker, metadata: { ...ticker.metadata, watchlists: ticker.metadata.watchlists.filter((id) => id !== watchlistId) } });
    }
  }
  return { create, update };
}

/**
 * The workspace a first run lands on: the holdings as a mark-to-market
 * heatmap, a watchlist, and the largest position's chart and news. One small
 * floating pane shows that panes are windows. Anything the host cannot render
 * is left out rather than shown as a placeholder.
 */
export function buildFirstRunLayout({
  symbol,
  portfolioId,
  watchlistId,
  hasPane,
}: {
  symbol: string;
  portfolioId: string;
  watchlistId: string;
  hasPane: (paneId: string) => boolean;
}): SavedLayout {
  const instances: PaneInstanceConfig[] = [
    {
      instanceId: FIRST_RUN_PANE_IDS.heatmap,
      paneId: "portfolio-list",
      params: { collectionId: portfolioId },
      settings: {
        columnIds: [...DEFAULT_PORTFOLIO_COLUMN_IDS],
        collectionScope: "portfolios",
        visibleCollectionIds: [],
        viewMode: "grid",
      },
      binding: { kind: "none" },
    },
    {
      instanceId: FIRST_RUN_PANE_IDS.watchlist,
      paneId: "portfolio-list",
      params: { collectionId: watchlistId },
      settings: {
        columnIds: DEFAULT_COLUMNS.map((column) => column.id),
        collectionScope: "watchlists",
        visibleCollectionIds: [],
        viewMode: "table",
      },
      binding: { kind: "none" },
    },
    {
      instanceId: FIRST_RUN_PANE_IDS.chart,
      paneId: CHART_COMPOSER_PANE_ID,
      binding: { kind: "fixed", symbol },
    },
  ];
  const secondary = hasPane("ticker-news")
    ? { instanceId: FIRST_RUN_PANE_IDS.news, paneId: "ticker-news", binding: { kind: "fixed" as const, symbol } }
    : hasPane("world-indices")
      ? { instanceId: FIRST_RUN_PANE_IDS.indices, paneId: "world-indices", binding: { kind: "none" as const } }
      : null;
  if (secondary) instances.push(secondary);

  // The float is a market read that stands on its own: sentiment when the
  // plugin is installed, else the indices. The shell clamps floats into the
  // window, so an off-screen origin lands it in the bottom-right corner on
  // any size, over the news list rather than the chart.
  const floatingPaneId = hasPane("fear-greed")
    ? "fear-greed"
    : secondary?.paneId !== "world-indices" && hasPane("world-indices")
      ? "world-indices"
      : null;
  const floating: LayoutConfig["floating"] = [];
  if (floatingPaneId) {
    const instanceId = floatingPaneId === "fear-greed" ? FIRST_RUN_PANE_IDS.sentiment : FIRST_RUN_PANE_IDS.indices;
    instances.push({ instanceId, paneId: floatingPaneId, binding: { kind: "none" } });
    floating.push({ instanceId, x: 9999, y: 9999, width: 46, height: floatingPaneId === "fear-greed" ? 12 : 11 });
  }

  const layout: LayoutConfig = {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.36,
      first: {
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.heatmap },
        second: { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.watchlist },
      },
      second: secondary
        ? {
          kind: "split",
          axis: "vertical",
          ratio: 0.62,
          first: { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.chart },
          second: { kind: "pane", instanceId: secondary.instanceId },
        }
        : { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.chart },
    },
    instances,
    floating,
    detached: [],
  };
  return {
    name: "Home",
    layout,
    paneState: {},
    focusedPaneId: FIRST_RUN_PANE_IDS.chart,
  };
}

/** Replaces the Home layout with the first-run workspace and makes it active. */
export function applyFirstRunLayout(config: AppConfig, home: SavedLayout): AppConfig {
  const layouts = config.layouts.length > 0 ? [home, ...config.layouts.slice(1)] : [home];
  return {
    ...config,
    layouts,
    layout: home.layout,
    activeLayoutIndex: 0,
  };
}
