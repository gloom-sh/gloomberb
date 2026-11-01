import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type SavedLayout } from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import {
  FIRST_RUN_PANE_IDS,
  applyFirstRunLayout,
  buildFirstRunLayout,
  onboardingDeskLayoutId,
  planFirstRunWatchlist,
  setupDeskPicks,
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
    const panes = ["portfolio-list", "chart-composer", "news-top", "ticker-news", "world-indices", "fear-greed"];
    const build = (hasPane: (id: string) => boolean) => buildFirstRunLayout({
      symbol: "MSFT",
      portfolioId: "main",
      watchlistId: "watchlist",
      hasPane,
    });
    const home = build((id) => panes.includes(id));
    const byId = new Map(home.layout.instances.map((instance) => [instance.instanceId, instance]));
    expect(byId.get(FIRST_RUN_PANE_IDS.heatmap)).toMatchObject({ paneId: "portfolio-list", settings: { viewMode: "grid", collectionScope: "portfolios" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.watchlist)).toMatchObject({ params: { collectionId: "watchlist" }, settings: { viewMode: "table", collectionScope: "watchlists" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.chart)).toMatchObject({ paneId: "chart-composer", binding: { kind: "fixed", symbol: "MSFT" } });
    expect(byId.get(FIRST_RUN_PANE_IDS.news)).toMatchObject({ paneId: "news-top", binding: { kind: "none" } });
    expect(home.layout.instances.some((instance) => instance.paneId === "ticker-news")).toBe(false);
    expect(home.layout.floating.map((entry) => entry.instanceId)).toEqual([FIRST_RUN_PANE_IDS.sentiment]);
    expect(home.focusedPaneId).toBe(FIRST_RUN_PANE_IDS.chart);
    // Without the gauge, the indices float instead.
    const withoutGauge = build((id) => id !== "fear-greed" && panes.includes(id));
    expect(withoutGauge.layout.floating.map((entry) => entry.instanceId)).toEqual([FIRST_RUN_PANE_IDS.indices]);
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

  test("running again replaces the layouts it made and leaves the user's alone", () => {
    const config = createDefaultConfig("/tmp/first-run");
    const home = (symbol: string) => buildFirstRunLayout({ symbol, portfolioId: "main", watchlistId: "watchlist", hasPane: () => true });
    const desk = (key: "rates" | "fx" | "options", name: string) => ({ ...home("SPY"), name, id: onboardingDeskLayoutId(key) });
    const first = applyFirstRunLayout(config, home("AAPL"), [desk("rates", "Rates"), desk("fx", "FX & Macro")]);
    expect(first.layouts.map((layout) => layout.name)).toEqual(["Home", "Rates", "FX & Macro", "Monitor", "Macro"]);

    // The user moves their own layout to the front and adds one of their own.
    const mine: SavedLayout = { name: "Mine", layout: home("TSLA").layout };
    const [onboardingHome, rates, fx, monitor, macro] = first.layouts;
    const edited = { ...first, layouts: [monitor!, onboardingHome!, rates!, fx!, macro!, mine], activeLayoutIndex: 5 };

    const again = applyFirstRunLayout(edited, home("MSFT"), [desk("rates", "Rates"), desk("fx", "FX & Macro")]);
    expect(again.layouts).toHaveLength(edited.layouts.length);
    expect(again.layouts.map((layout) => layout.name)).toEqual(["Monitor", "Home", "Rates", "FX & Macro", "Macro", "Mine"]);
    expect(again.layouts[0]).toBe(monitor!);
    expect(again.layouts.slice(4)).toEqual([macro!, mine]);
    expect(again.activeLayoutIndex).toBe(1);
    expect(again.layout.instances.find((instance) => instance.instanceId === FIRST_RUN_PANE_IDS.chart)?.binding)
      .toEqual({ kind: "fixed", symbol: "MSFT" });

    // Other picks replace the desks it made, and a skip removes them.
    expect(applyFirstRunLayout(again, home("MSFT"), [desk("options", "Options")]).layouts.map((layout) => layout.name))
      .toEqual(["Monitor", "Home", "Options", "Macro", "Mine"]);
    expect(applyFirstRunLayout(again, home("MSFT")).layouts.map((layout) => layout.name))
      .toEqual(["Monitor", "Home", "Macro", "Mine"]);
  });

  test("a run from Settings rebuilds what setup made before it tagged its layouts, and replaces nothing else", () => {
    const home = (symbol: string) => buildFirstRunLayout({ symbol, portfolioId: "main", watchlistId: "watchlist", hasPane: () => true });
    const desk = (key: "rates" | "fx" | "options", name: string) => ({ ...home("SPY"), name, id: onboardingDeskLayoutId(key) });
    const untagged = (name: string): SavedLayout => ({ name, layout: home("TSLA").layout });
    // Setup's Home and desks as older builds left them, then the user's own:
    // a later Rates tab is theirs, since only the run right after Home is setup's.
    const older = {
      ...createDefaultConfig("/tmp/first-run"),
      layouts: [untagged("Home"), untagged("Rates"), untagged("FX & Macro"), untagged("Monitor"), untagged("Rates")],
    };
    expect(setupDeskPicks(older)).toEqual(["rates", "fx"]);

    const again = applyFirstRunLayout(older, home("MSFT"), [desk("rates", "Rates"), desk("fx", "FX & Macro")], { rerun: true });
    expect(again.layouts.map((layout) => layout.name)).toEqual(["Home", "Rates", "FX & Macro", "Monitor", "Rates"]);
    expect(again.layouts.map((layout) => layout.id)).toEqual([
      "onboarding:home", onboardingDeskLayoutId("rates"), onboardingDeskLayoutId("fx"), undefined, undefined,
    ]);
    expect(again.layouts.slice(3)).toEqual(older.layouts.slice(3));
    expect(setupDeskPicks(again)).toEqual(["rates", "fx"]);

    // A first tab that is not Home is the user's: Home goes in ahead of it.
    const renamed = { ...older, layouts: [untagged("Main"), ...older.layouts.slice(1)] };
    expect(setupDeskPicks(renamed)).toEqual([]);
    const kept = applyFirstRunLayout(renamed, home("MSFT"), [], { rerun: true });
    expect(kept.layouts.map((layout) => layout.name)).toEqual(["Home", "Main", "Rates", "FX & Macro", "Monitor", "Rates"]);
    expect(kept.layouts.slice(1)).toEqual(renamed.layouts);
  });
});
