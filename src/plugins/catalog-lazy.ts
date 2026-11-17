import type { GloomPlugin } from "../types/plugin";

/**
 * The built-in plugins of the catalog, each loaded when first asked for. A command line that needs one function,
 * or only the plugin that serves market data, takes that plugin's code and not the other thirty's.
 * `catalog-lazy.test.ts` keeps this list the same as `uiBuiltinPlugins`, which the apps load whole.
 */
export interface LazyBuiltinPlugin {
  id: string;
  load(): GloomPlugin;
}

const lazy = (id: string, load: () => GloomPlugin): LazyBuiltinPlugin => ({ id, load });

export const lazyBuiltinPlugins: readonly LazyBuiltinPlugin[] = [
  lazy("gloomberb-cloud", () => require("./builtin/cloud").gloomberbCloudPlugin),
  lazy("portfolio", () => require("./builtin/composite/portfolio").portfolioPlugin),
  lazy("ticker-core", () => require("./builtin/composite/ticker-core").tickerCorePlugin),
  lazy("options-volatility", () => require("./builtin/composite/options-volatility").optionsVolatilityPlugin),
  lazy("ownership", () => require("./builtin/composite/ownership").ownershipPlugin),
  lazy("filings", () => require("./builtin/composite/filings").filingsPlugin),
  lazy("broker", () => require("./builtin/composite/broker").brokerPlugin),
  lazy("application", () => require("./builtin/composite/application").applicationPlugin),
  lazy("news", () => require("./builtin/news").newsPlugin),
  lazy("notes", () => require("./builtin/notes").notesPlugin),
  lazy("custom-view", () => require("./builtin/custom-view").customViewPlugin),
  lazy("global-markets", () => require("./builtin/composite/global-markets").globalMarketsPlugin),
  lazy("screeners", () => require("./builtin/composite/screeners").screenersPlugin),
  lazy("futures-commodities", () => require("./builtin/composite/futures-commodities").futuresCommoditiesPlugin),
  lazy("crypto", () => require("./builtin/composite/crypto").cryptoPlugin),
  lazy("alt-data", () => require("./builtin/composite/alt-data").altDataPlugin),
  lazy("quant", () => require("./builtin/composite/quant").quantPlugin),
  lazy("market-heatmap", () => require("./builtin/market-heatmap").marketHeatmapPlugin),
  lazy("market-halts", () => require("./builtin/market-halts").marketHaltsPlugin),
  lazy("fear-greed", () => require("./builtin/fear-greed").fearGreedPlugin),
  lazy("members", () => require("./builtin/members").membersPlugin),
  lazy("ipo-calendar", () => require("./builtin/ipo-calendar").ipoCalendarPlugin),
  lazy("clinical-trials", () => require("./builtin/clinical-trials").clinicalTrialsPlugin),
  lazy("comment-letters", () => require("./builtin/comment-letters").commentLettersPlugin),
  lazy("openfda", () => require("./builtin/openfda").openFdaPlugin),
  lazy("rates-macro", () => require("./builtin/composite/rates-macro").ratesMacroPlugin),
  lazy("credit", () => require("./builtin/composite/credit").creditPlugin),
  lazy("earnings", () => require("./builtin/composite/earnings").earningsPlugin),
  lazy("alerts", () => require("./builtin/alerts").alertsPlugin),
  lazy("research-search", () => require("./builtin/research-search").researchSearchPlugin),
];

/** The built-in plugin with this id, loaded now; undefined for an id no built-in plugin has. */
export function loadBuiltinPlugin(id: string): GloomPlugin | undefined {
  return lazyBuiltinPlugins.find((plugin) => plugin.id === id)?.load();
}
