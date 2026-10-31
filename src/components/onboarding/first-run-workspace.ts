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
import { MAX_DESK_PICKS, type DeskKey } from "../../layout/desk-keys";
import { DESKS, isDeskKey } from "../../layout/desks";

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
const FIRST_RUN_WATCHLIST_SIZE = 7;

export const FIRST_RUN_PANE_IDS = {
  heatmap: "portfolio-list:home-heatmap",
  watchlist: "portfolio-list:home-watchlist",
  chart: "chart-composer:home",
  news: "news-top:home",
  indices: "world-indices:home",
  sentiment: "fear-greed:home",
  trending: "attention-trending:home",
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
 * heatmap, a watchlist, the largest position's chart, and the top news wire.
 * One small floating pane shows that panes are windows. Anything the host
 * cannot render is left out rather than shown as a placeholder.
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
  // Top news is the curated wire; the per-ticker feed is the fallback when the
  // wire pane is not registered.
  const secondary = hasPane("news-top")
    ? { instanceId: FIRST_RUN_PANE_IDS.news, paneId: "news-top", binding: { kind: "none" as const } }
    : hasPane("ticker-news")
      ? { instanceId: "ticker-news:home", paneId: "ticker-news", binding: { kind: "fixed" as const, symbol } }
      : hasPane("world-indices")
        ? { instanceId: FIRST_RUN_PANE_IDS.indices, paneId: "world-indices", binding: { kind: "none" as const } }
        : null;
  if (secondary) instances.push(secondary);
  const trending = hasPane("attention-trending");
  if (trending) instances.push({ instanceId: FIRST_RUN_PANE_IDS.trending, paneId: "attention-trending", binding: { kind: "none" } });
  const lower = secondary && trending ? { kind: "split" as const, axis: "horizontal" as const, ratio: 0.6,
    first: { kind: "pane" as const, instanceId: secondary.instanceId }, second: { kind: "pane" as const, instanceId: FIRST_RUN_PANE_IDS.trending } }
    : { kind: "pane" as const, instanceId: secondary?.instanceId ?? FIRST_RUN_PANE_IDS.trending };

  // The float is a market read that stands on its own: the Fear & Greed
  // gauge, else the indices where a host has no gauge. The shell clamps floats
  // into the window, so an off-screen origin lands it in the bottom-right
  // corner on any size, over the news list rather than the chart. The gauge
  // takes 16 rows to reach its reading in the terminal, under the prior scores.
  const floatingPaneId = hasPane("fear-greed")
    ? "fear-greed"
    : secondary?.paneId !== "world-indices" && hasPane("world-indices")
      ? "world-indices"
      : null;
  const floating: LayoutConfig["floating"] = [];
  if (floatingPaneId) {
    const gauge = floatingPaneId === "fear-greed";
    const instanceId = gauge ? FIRST_RUN_PANE_IDS.sentiment : FIRST_RUN_PANE_IDS.indices;
    instances.push({ instanceId, paneId: floatingPaneId, binding: { kind: "none" } });
    floating.push({ instanceId, x: 9999, y: 9999, width: gauge ? 46 : 60, height: gauge ? 16 : 12 });
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
      second: secondary || trending
        ? {
          kind: "split",
          axis: "vertical",
          ratio: 0.62,
          first: { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.chart },
          second: lower,
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

/**
 * The ids of the layouts onboarding makes. Running it again finds its own
 * layouts by these and replaces them, so it never adds a copy; a layout
 * without one is the user's.
 */
const ONBOARDING_HOME_LAYOUT_ID = "onboarding:home";
const ONBOARDING_LAYOUT_ID_PREFIX = "onboarding:";
const ONBOARDING_DESK_LAYOUT_ID_PREFIX = `${ONBOARDING_LAYOUT_ID_PREFIX}desk:`;

export function onboardingDeskLayoutId(desk: DeskKey): string {
  return `${ONBOARDING_DESK_LAYOUT_ID_PREFIX}${desk}`;
}

function isOnboardingLayout(layout: SavedLayout): boolean {
  return layout.id?.startsWith(ONBOARDING_LAYOUT_ID_PREFIX) === true;
}

/**
 * Takes back the layouts setup made before it tagged them, so a run from
 * Settings rebuilds them in place instead of copying them. Such a profile
 * has setup's Home first and its desks right after it, under the desks'
 * names. A first layout not called Home is the user's, and so is
 * everything after the desks.
 */
function adoptUntaggedSetupLayouts(config: AppConfig): AppConfig {
  const [first, ...rest] = config.layouts;
  if (!first || first.name !== "Home" || config.layouts.some(isOnboardingLayout)) return config;
  const desks: SavedLayout[] = [];
  for (const layout of rest) {
    const key = DESKS.find((desk) => desk.name === layout.name)?.key;
    if (!key || desks.length >= MAX_DESK_PICKS || desks.some((desk) => desk.id === onboardingDeskLayoutId(key))) break;
    desks.push({ ...layout, id: onboardingDeskLayoutId(key) });
  }
  return {
    ...config,
    layouts: [{ ...first, id: ONBOARDING_HOME_LAYOUT_ID }, ...desks, ...rest.slice(desks.length)],
  };
}

/** The desks setup made that are still tabs, in tab order: what a run from Settings starts with ticked. */
export function setupDeskPicks(config: AppConfig): DeskKey[] {
  const picks: DeskKey[] = [];
  for (const layout of adoptUntaggedSetupLayouts(config).layouts) {
    const key = layout.id?.startsWith(ONBOARDING_DESK_LAYOUT_ID_PREFIX)
      ? layout.id.slice(ONBOARDING_DESK_LAYOUT_ID_PREFIX.length)
      : null;
    if (isDeskKey(key) && !picks.includes(key)) picks.push(key);
  }
  return picks.slice(0, MAX_DESK_PICKS);
}

/**
 * Puts the first-run workspace in place and makes Home active: Home, then a
 * tab per picked desk. The layouts an earlier run made are replaced where
 * they stood, and a desk not picked this time goes with them; a first run
 * replaces the stock Home it starts with. Every other layout is the user's
 * and keeps its place and content. A run from Settings (`rerun`) also
 * rebuilds what setup made before it tagged its layouts, and with none of
 * setup's left it puts Home first, replacing nothing.
 */
export function applyFirstRunLayout(
  config: AppConfig,
  home: SavedLayout,
  desks: ReadonlyArray<SavedLayout & { id: string }> = [],
  { rerun = false }: { rerun?: boolean } = {},
): AppConfig {
  const { layouts: current } = rerun ? adoptUntaggedSetupLayouts(config) : config;
  const earlier = current.findIndex(isOnboardingLayout);
  const users = current.filter((layout) => !isOnboardingLayout(layout));
  // Everything before the first layout onboarding made is the user's, so its index holds.
  const at = earlier >= 0 ? earlier : 0;
  const kept = earlier >= 0 || rerun ? users : users.slice(1);
  const layouts = [
    ...kept.slice(0, at),
    { ...home, id: ONBOARDING_HOME_LAYOUT_ID },
    ...desks,
    ...kept.slice(at),
  ];
  return {
    ...config,
    layouts,
    layout: home.layout,
    activeLayoutIndex: at,
  };
}
