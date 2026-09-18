import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import {
  FIRST_RUN_PANE_IDS,
  applyFirstRunLayout,
  buildFirstRunLayout,
  planFirstRunWatchlist,
} from "./first-run-workspace";

function ticker(symbol: string, { held = false, watched = false } = {}): [string, TickerRecord] {
  return [symbol, {
    metadata: {
      ticker: symbol,
      watchlists: watched ? ["watchlist"] : [],
      portfolios: held ? ["main"] : [],
      positions: held ? [{ portfolio: "main", shares: 1, avgCost: 1, currency: "USD", broker: "manual" }] : [],
    },
  } as unknown as TickerRecord];
}

describe("first-run workspace", () => {
  test("creates the preferred names, capped at seven, skipping holdings", () => {
    const plan = planFirstRunWatchlist(new Map([ticker("AAPL", { held: true }), ticker("MSFT", { held: true })]), "watchlist", "main");
    expect(plan.create.map((seed) => seed.ticker)).toEqual(["SPY", "QQQ", "NVDA", "AMZN", "TSLA"]);
    expect(plan.create[0]).toMatchObject({ watchlists: ["watchlist"], portfolios: [], positions: [], currency: "USD" });
    expect(plan.update).toEqual([]);
  });

  test("trims the startup seed to seven and drops holdings from it", () => {
    // Startup seeds twelve names; the user holds two of them.
    const seeded = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "BRK.B", "JPM", "V", "BTC-USD", "ETH-USD"];
    const tickers = new Map(seeded.map((symbol) => ticker(symbol, { watched: true, held: symbol === "AAPL" || symbol === "NVDA" })));
    const plan = planFirstRunWatchlist(tickers, "watchlist", "main");
    expect(plan.create.map((seed) => seed.ticker)).toEqual(["SPY", "QQQ"]);
    const left = plan.update.filter((entry) => !entry.metadata.watchlists.includes("watchlist")).map((entry) => entry.metadata.ticker).sort();
    expect(left).toEqual(["AAPL", "BRK.B", "BTC-USD", "ETH-USD", "JPM", "NVDA", "V"]);
    expect(plan.update.every((entry) => !entry.metadata.watchlists.includes("watchlist"))).toBe(true);
    const kept = seeded.filter((symbol) => !left.includes(symbol));
    expect(kept).toEqual(["MSFT", "GOOGL", "AMZN", "TSLA", "META"]);
    expect(kept.length + plan.create.length).toBe(7);
  });

  test("lays out heatmap, watchlist, chart and top news, floating a market read", () => {
    const home = buildFirstRunLayout({
      symbol: "MSFT",
      portfolioId: "main",
      watchlistId: "watchlist",
      hasPane: (id) => ["portfolio-list", "chart-composer", "news-top", "ticker-news", "world-indices"].includes(id),
    });
    const byId = new Map(home.layout.instances.map((instance) => [instance.instanceId, instance]));
    expect(byId.get(FIRST_RUN_PANE_IDS.heatmap)).toMatchObject({ paneId: "portfolio-list", settings: { viewMode: "grid", collectionScope: "portfolios" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.watchlist)).toMatchObject({ params: { collectionId: "watchlist" }, settings: { viewMode: "table", collectionScope: "watchlists" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.chart)).toMatchObject({ paneId: "chart-composer", binding: { kind: "fixed", symbol: "MSFT" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.news)).toMatchObject({ paneId: "news-top", binding: { kind: "none" } });
    expect(home.layout.instances.some((instance) => instance.paneId === "ticker-news")).toBe(false);
    expect(home.layout.floating.map((entry) => entry.instanceId)).toEqual([FIRST_RUN_PANE_IDS.indices]);
    expect(home.focusedPaneId).toBe(FIRST_RUN_PANE_IDS.chart);
  });

  test("skips panes the host cannot render instead of leaving placeholders", () => {
    const home = buildFirstRunLayout({
      symbol: "MSFT",
      portfolioId: "main",
      watchlistId: "watchlist",
      hasPane: (id) => id === "portfolio-list" || id === "chart-composer",
    });
    expect(home.layout.instances.map((instance) => instance.paneId).sort()).toEqual(["chart-composer", "portfolio-list", "portfolio-list"]);
    expect(home.layout.floating).toEqual([]);
    expect(home.layout.dockRoot).toMatchObject({ second: { kind: "pane", instanceId: FIRST_RUN_PANE_IDS.chart } });
  });

  test("replaces Home and makes it the active layout", () => {
    const config = createDefaultConfig("/tmp/first-run");
    const home = buildFirstRunLayout({ symbol: "AAPL", portfolioId: "main", watchlistId: "watchlist", hasPane: () => true });
    const next = applyFirstRunLayout({ ...config, activeLayoutIndex: 2 }, home);
    expect(next.layouts.map((layout) => layout.name)).toEqual(["Home", "Monitor", "Macro"]);
    expect(next.layout).toBe(home.layout);
    expect(next.activeLayoutIndex).toBe(0);
  });
});
