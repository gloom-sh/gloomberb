import { afterEach, describe, expect, test } from "bun:test";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../data/config/store/normalize";
import { CURRENT_CONFIG_VERSION, createDefaultConfig, createPaneInstance, normalizePaneId } from "../types/config";
import { getLoadablePlugins } from "./catalog";
import {
  builtinPluginGroupMembers,
  encodeBuiltinDisabledPluginIds,
  expandBuiltinPluginGroups,
  normalizeBuiltinDisabledPluginIds,
  retiredBuiltinModuleIds,
  setBuiltinPluginGroupsForTests,
} from "./ownership";

afterEach(() => setBuiltinPluginGroupsForTests(null));

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

  test("no plugin belongs to two groups", () => {
    expect(new Set([...MACRO, ...MARKET_OVERVIEW]).size).toBe(MACRO.length + MARKET_OVERVIEW.length);
    expect(load(["macro"]).some((pluginId) => MARKET_OVERVIEW.includes(pluginId))).toBe(false);
  });

  test("a saved workspace from before the splits loads as it was", () => {
    const paneIds = ["econ-calendar", "cds", "earnings-calendar", "world-venue-map", "correlation", "attention"];
    const instances = paneIds.map((paneId) => createPaneInstance(paneId, { instanceId: `${paneId}:main`, binding: { kind: "none" } }));
    const floating = instances.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: 0, width: 40, height: 10, zIndex: index }));
    const layout = { dockRoot: null, instances, floating, detached: [] };
    const paneState = {
      "cds:main": { pluginState: { macro: { "cds:tenor": "10y" } } },
      "world-venue-map:main": { pluginState: { "market-overview": { layer: "ships" } } },
      "attention:main": { pluginState: { "market-overview": { "attention:tab": "countries" } } },
    };
    const pluginConfig = { macro: { "yield-curve:forward": "1y" }, "market-overview": { "correlation:window": 60 } };
    const saved = { ...createDefaultConfig("/gloom"), layout, layouts: [{ name: "Desk", layout, paneState }], pluginConfig };
    const { config } = normalizeLoadedConfig(saved, "/gloom");
    expect(config.layout.instances.map((instance) => instance.paneId)).toEqual(paneIds);
    expect(config.layouts[0]?.paneState).toEqual(paneState);
    expect(config.pluginConfig).toEqual(pluginConfig);
  });
});

describe("overlapping groups", () => {
  // Shaped like the planned Ticker Research split, which shares two successors with Macro.
  const GROUPS = { macro: MACRO, "ticker-research": ["ticker-core", "options-volatility", "credit", "earnings"] };

  test.each([
    {
      saved: ["ticker-research", "macro"],
      loaded: ["ticker-core", "options-volatility", "credit", "earnings", "rates-macro"],
      resaved: ["ticker-research", "macro"],
    },
    { saved: ["ticker-research"], loaded: ["ticker-core", "options-volatility", "credit", "earnings"], resaved: ["ticker-research"] },
  ])("$saved round-trips", ({ saved, loaded, resaved }) => {
    setBuiltinPluginGroupsForTests(GROUPS);
    expect(load(saved)).toEqual(loaded);
    expect(save(load(saved))).toEqual(resaved);
  });

  test("expanding what was encoded gives back the same switched-off plugins", () => {
    setBuiltinPluginGroupsForTests(GROUPS);
    for (const disabled of [
      [],
      ["credit"],
      MACRO,
      ["earnings", "external-plugin", "credit", "rates-macro"],
      ["ticker-core", "options-volatility", "credit", "earnings", "rates-macro", "news"],
      ["ticker-core", "options-volatility", "credit"],
    ]) {
      expect(expandBuiltinPluginGroups(encodeBuiltinDisabledPluginIds(disabled)).sort()).toEqual([...disabled].sort());
    }
  });
});
