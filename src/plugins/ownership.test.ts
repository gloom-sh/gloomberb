import { describe, expect, test } from "bun:test";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../data/config/store/normalize";
import { CURRENT_CONFIG_VERSION, createDefaultConfig, createPaneInstance, normalizePaneId } from "../types/config";
import { getLoadablePlugins } from "./catalog";
import {
  builtinPluginGroupMembers,
  encodeBuiltinDisabledPluginIds,
  expandBuiltinPluginGroups,
  normalizeBuiltinDisabledPluginIds,
  retiredBuiltinModuleIds,
} from "./ownership";


/** `disabledPlugins` as the app holds it after loading a config.json that saved these. */
function load(disabledPlugins: readonly string[], configVersion = CURRENT_CONFIG_VERSION): string[] {
  const saved = { ...createDefaultConfig("/gloom"), configVersion, disabledPlugins: [...disabledPlugins] };
  return normalizeLoadedConfig(saved, "/gloom", { hasPluginCheckout: () => false }).config.disabledPlugins;
}

/** `disabledPlugins` as config.json gets it when the app saves these. */
function save(disabledPlugins: readonly string[]): string[] {
  return normalizeConfigForSave({ ...createDefaultConfig("/gloom"), disabledPlugins: [...disabledPlugins] }).disabledPlugins;
}

const MACRO = ["rates-macro", "credit", "earnings"];
const MARKET_OVERVIEW = ["global-markets", "screeners", "futures-commodities", "crypto", "alt-data", "quant"];
const TICKER_RESEARCH = ["ticker-core", "options-volatility", "ownership", "filings", "alt-data", "quant", "credit", "earnings"];
const without = (list: readonly string[], pluginId: string) => list.filter((entry) => entry !== pluginId);

describe("retired plugins in disabledPlugins", () => {
  test.each([
    { name: "macro alone turns off all three successors", saved: ["macro"], loaded: MACRO, resaved: ["macro"] },
    { name: "market-overview alone turns off all six", saved: ["market-overview"], loaded: MARKET_OVERVIEW, resaved: ["market-overview"] },
    { name: "one successor off stays itself", saved: ["news", "credit"], loaded: ["news", "credit"], resaved: ["news", "credit"] },
    { name: "five of six off stay themselves", saved: MARKET_OVERVIEW.slice(1), loaded: MARKET_OVERVIEW.slice(1), resaved: MARKET_OVERVIEW.slice(1) },
    {
      name: "an older app turning Macro off over one successor already off",
      saved: ["credit", "macro"],
      loaded: ["credit", "rates-macro", "earnings"],
      resaved: ["macro"],
    },
    {
      name: "an older app turning Market Overview off over one successor already off",
      saved: ["quant", "market-overview"],
      loaded: ["quant", "global-markets", "screeners", "futures-commodities", "crypto", "alt-data"],
      resaved: ["market-overview"],
    },
    { name: "both groups off", saved: ["market-overview", "macro"], loaded: [...MARKET_OVERVIEW, ...MACRO], resaved: ["market-overview", "macro"] },
    { name: "ticker-research alone turns off all eight", saved: ["ticker-research"], loaded: TICKER_RESEARCH, resaved: ["ticker-research"] },
    {
      name: "ticker-research and macro, which share two successors",
      saved: ["macro", "ticker-research"],
      loaded: ["rates-macro", "credit", "earnings", "ticker-core", "options-volatility", "ownership", "filings", "alt-data", "quant"],
      resaved: ["macro", "ticker-research"],
    },
    { name: "one Ticker Research successor off stays itself", saved: ["ownership"], loaded: ["ownership"], resaved: ["ownership"] },
    {
      // Seven of eight, as after turning Credit & Bonds back on: the alias goes, the rest stay off.
      name: "Credit & Bonds back on after ticker-research was off",
      saved: without(TICKER_RESEARCH, "credit"),
      loaded: without(TICKER_RESEARCH, "credit"),
      resaved: without(TICKER_RESEARCH, "credit"),
    },
    {
      name: "an older app turning Ticker Research off over one successor already off",
      saved: ["ownership", "ticker-research"],
      loaded: ["ownership", ...without(TICKER_RESEARCH, "ownership")],
      resaved: ["ticker-research"],
    },
  ])("$name", ({ saved, loaded, resaved }) => {
    expect(load(saved)).toEqual(loaded);
    expect(save(load(saved))).toEqual(resaved);
    // Loading what was saved changes nothing, however often it goes round.
    expect(load(save(load(saved))).sort()).toEqual([...loaded].sort());
    expect(save(load(save(load(saved))))).toEqual(resaved);
  });

  test("an older app turning the old plugin back on brings every successor back", () => {
    const written = save([...MACRO, ...MARKET_OVERVIEW, "news"]);
    expect(written).toEqual(["macro", "market-overview", "news"]);
    // The older app knows only the old ids, and drops one.
    expect(load(written.filter((pluginId) => pluginId !== "market-overview"))).toEqual([...MACRO, "news"]);
    expect(load(written.filter((pluginId) => pluginId !== "macro"))).toEqual([...MARKET_OVERVIEW, "news"]);

    // Where groups share successors, dropping one old id leaves those on that
    // the other still covers.
    const all = save([...new Set([...MACRO, ...MARKET_OVERVIEW, ...TICKER_RESEARCH])]);
    expect(all).toEqual(["macro", "ticker-research", "market-overview"]);
    expect(load(without(all, "ticker-research")).sort()).toEqual([...new Set([...MACRO, ...MARKET_OVERVIEW])].sort());
    expect(load(without(all, "macro")).sort()).toEqual([...new Set([...MARKET_OVERVIEW, ...TICKER_RESEARCH])].sort());
  });

  test("migrations read the old ids before they are expanded", () => {
    // The IPO Calendar was a Macro module, and Market Heatmap, Market Halts
    // and Fear & Greed Market Overview ones: a config from before they moved
    // out keeps them off where their owner was off, which the migrations see
    // only under the old id.
    expect(load(["macro"], 22)).toEqual([...MACRO, "ipo-calendar"]);
    expect(load(["market-overview"], 22)).toEqual([...MARKET_OVERVIEW, "market-heatmap", "market-halts", "fear-greed"]);
  });

  // A module that moves to another plugin must take its old id along, or
  // switching that id off would switch off a plugin it no longer belongs to.
  test("every retired module id switches off the plugin that holds its pane now", () => {
    const plugins = getLoadablePlugins();
    const pluginIds = new Set(plugins.map((plugin) => plugin.id));
    const paneOwners = new Map(plugins.flatMap((plugin) => (plugin.panes ?? []).map((pane) => [pane.id, plugin.id] as const)));
    // TV left for its own repository; switching it off was switching Macro off.
    const meansWholeGroup = new Set(["macro-tv"]);
    for (const moduleId of retiredBuiltinModuleIds()) {
      const [target] = normalizeBuiltinDisabledPluginIds([moduleId]);
      // Application's, which cannot be switched off.
      if (target === undefined) continue;
      const paneOwner = paneOwners.get(normalizePaneId(moduleId));
      if (paneOwner) expect({ moduleId, target }).toEqual({ moduleId, target: paneOwner });
      else if (builtinPluginGroupMembers(target)) expect({ moduleId, target, wholeGroup: meansWholeGroup.has(moduleId) }).toEqual({ moduleId, target, wholeGroup: true });
      else expect({ moduleId, registered: pluginIds.has(target) }).toEqual({ moduleId, registered: true });
    }
  });

  // Ticker Research shares Credit & Bonds and Earnings with Macro, and Alt
  // Data and Quant with Market Overview: each holds modules from both.
  test("groups share the successors that hold modules from both, and stay a pure function of the table", () => {
    expect(TICKER_RESEARCH.filter((pluginId) => MACRO.includes(pluginId))).toEqual(["credit", "earnings"]);
    expect(TICKER_RESEARCH.filter((pluginId) => MARKET_OVERVIEW.includes(pluginId))).toEqual(["alt-data", "quant"]);
    expect(MACRO.filter((pluginId) => MARKET_OVERVIEW.includes(pluginId))).toEqual([]);
    expect(load(["ticker-research"]).some((pluginId) => ["rates-macro", "global-markets"].includes(pluginId))).toBe(false);

    for (const disabled of [
      [],
      ["credit"],
      MACRO,
      TICKER_RESEARCH,
      [...MACRO, "ticker-core"],
      ["earnings", "external-plugin", "credit", "rates-macro", "quant"],
      without(TICKER_RESEARCH, "quant"),
      [...new Set([...MARKET_OVERVIEW, ...TICKER_RESEARCH])],
      [...new Set([...MACRO, ...MARKET_OVERVIEW, ...TICKER_RESEARCH, "news"])],
    ]) {
      const encoded = encodeBuiltinDisabledPluginIds(disabled);
      expect(expandBuiltinPluginGroups(encoded).sort()).toEqual([...disabled].sort());
      expect(encodeBuiltinDisabledPluginIds(expandBuiltinPluginGroups(encoded))).toEqual(encoded);
    }
  });

  test("a saved workspace from before the splits loads as it was", () => {
    const paneIds = [
      "ticker-research", "options", "holders", "sec", "credit-documents", "earnings-ripple", "supply-chain", "backtest",
      "econ-calendar", "cds", "earnings-calendar", "world-venue-map", "correlation", "attention",
    ];
    const instances = paneIds.map((paneId) => createPaneInstance(paneId, {
      instanceId: `${paneId}:main`,
      binding: { kind: "fixed", symbol: "AAPL" },
    }));
    const floating = instances.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: 0, width: 40, height: 10, zIndex: index }));
    const layout = { dockRoot: null, instances, floating, detached: [] };
    const paneState = {
      "ticker-research:main": { activeTabId: "holders", pluginState: { "ticker-research": { chartRange: "5Y" } } },
      "credit-documents:main": { pluginState: { "ticker-research": { "credit:tab": "covenants" } } },
      "earnings-ripple:main": { pluginState: { "ticker-research": { tab: "suppliers" } } },
      "cds:main": { pluginState: { macro: { "cds:tenor": "10y" } } },
      "world-venue-map:main": { pluginState: { "market-overview": { layer: "ships" } } },
      "attention:main": { pluginState: { "market-overview": { "attention:tab": "countries" } } },
    };
    const pluginConfig = {
      "ticker-research": { priceLevels: { AAPL: [200] } },
      macro: { "yield-curve:forward": "1y" },
      "market-overview": { "correlation:window": 60 },
    };
    const saved = { ...createDefaultConfig("/gloom"), layout, layouts: [{ name: "Desk", layout, paneState }], pluginConfig };
    const { config } = normalizeLoadedConfig(saved, "/gloom");
    expect(config.layout.instances.map((instance) => instance.paneId)).toEqual(paneIds);
    expect(config.layouts[0]?.paneState).toEqual(paneState);
    expect(config.pluginConfig).toEqual(pluginConfig);
  });
});
