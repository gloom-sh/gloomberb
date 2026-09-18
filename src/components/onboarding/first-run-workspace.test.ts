import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import {
  FIRST_RUN_PANE_IDS,
  applyFirstRunLayout,
  buildFirstRunLayout,
  planFirstRunWatchlist,
} from "./first-run-workspace";

function ticker(symbol: string, watchlists: string[] = []): [string, TickerRecord] {
  return [symbol, { metadata: { ticker: symbol, watchlists, portfolios: ["main"], positions: [] } } as unknown as TickerRecord];
}

describe("first-run workspace", () => {
  test("seeds the watchlist around existing holdings, capped at seven rows", () => {
    const seeds = planFirstRunWatchlist(new Map([ticker("AAPL"), ticker("MSFT")]), "watchlist");
    expect(seeds.map((seed) => seed.ticker)).toEqual(["SPY", "QQQ", "NVDA", "AMZN", "TSLA"]);
    expect(seeds[0]).toMatchObject({ watchlists: ["watchlist"], portfolios: [], positions: [], currency: "USD" });

    const nearlyFull = new Map(["A", "B", "C", "D", "E", "F"].map((symbol) => ticker(symbol, ["watchlist"])));
    expect(planFirstRunWatchlist(nearlyFull, "watchlist").map((seed) => seed.ticker)).toEqual(["SPY"]);
  });

  test("lays out heatmap, watchlist, chart and news, floating a market read", () => {
    const home = buildFirstRunLayout({
      symbol: "MSFT",
      portfolioId: "main",
      watchlistId: "watchlist",
      hasPane: (id) => ["portfolio-list", "chart-composer", "ticker-news", "world-indices"].includes(id),
    });
    const byId = new Map(home.layout.instances.map((instance) => [instance.instanceId, instance]));
    expect(byId.get(FIRST_RUN_PANE_IDS.heatmap)).toMatchObject({ paneId: "portfolio-list", settings: { viewMode: "grid", collectionScope: "portfolios" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.watchlist)).toMatchObject({ params: { collectionId: "watchlist" }, settings: { viewMode: "table", collectionScope: "watchlists" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.chart)).toMatchObject({ paneId: "chart-composer", binding: { kind: "fixed", symbol: "MSFT" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.news)).toMatchObject({ paneId: "ticker-news", binding: { kind: "fixed", symbol: "MSFT" } });
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
