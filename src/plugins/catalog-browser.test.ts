import { describe, expect, test } from "bun:test";
import { browserBuiltinPlugins } from "./catalog-browser";
import { getLoadablePlugins } from "./catalog";

const ids = browserBuiltinPlugins.map((plugin) => plugin.id);
const paneIds = browserBuiltinPlugins.flatMap((plugin) => plugin.panes?.map((pane) => pane.id) ?? []);
const templateIds = new Set(browserBuiltinPlugins.flatMap((plugin) => plugin.paneTemplates?.map((template) => template.id) ?? []));

describe("browser plugin catalog", () => {
  test("contains the reviewed cloud, local, market, and research plugins", () => {
    expect(ids).toEqual([
      "gloomberb-cloud",
      "portfolio",
      "ticker-research",
      "application",
      "news",
      "market-overview",
      "macro",
      "alerts",
    ]);
  });

  test("excludes native, filesystem, local AI, debug, updater, and external plugins", () => {
    for (const forbidden of [
      "broker",
      "ibkr",
      "public",
      "robinhood",
      "simplefin",
      "notes",
      "substack",
      "ai",
      "debug",
      "yahoo",
      "prediction-markets",
      "polls",
      "updater",
    ]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  test("keeps every public pane handoff restorable in the hosted browser", () => {
    const unavailable = getLoadablePlugins()
      .flatMap((plugin) => plugin.paneTemplates ?? [])
      .filter((template) => template.publicShare && !templateIds.has(template.id))
      .map((template) => template.id);
    expect(unavailable).toEqual([]);
  });

  test("omits unsupported modules inside otherwise browser-safe product areas", () => {
    expect(paneIds).toEqual(expect.arrayContaining([
      "ticker-research",
      "chart-composer",
      "options-calculator",
      "ticker-news",
      "world-indices",
      "econ-calendar",
      "treasury-auctions",
    ]));
    for (const forbidden of [
      "buildout",
      "market-heatmap",
      "market-movers",
      "market-halts",
      "fear-greed",
      "earnings-calendar",
      "ipo-calendar",
      "tv",
      "dividend-yield",
      "short-interest",
      "thirteenf",
      "sec",
      "insider",
      "market-valuation",
    ]) {
      expect(paneIds).not.toContain(forbidden);
    }
  });
});
