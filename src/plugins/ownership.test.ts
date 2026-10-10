import { afterEach, describe, expect, test } from "bun:test";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../data/config/store/normalize";
import { CURRENT_CONFIG_VERSION, createDefaultConfig, createPaneInstance } from "../types/config";
import { encodeBuiltinDisabledPluginIds, expandBuiltinPluginGroups, setBuiltinPluginGroupsForTests } from "./ownership";

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

describe("Macro in disabledPlugins", () => {
  test.each([
    { name: "macro alone turns off all three successors", saved: ["macro"], loaded: MACRO, resaved: ["macro"] },
    { name: "one successor off stays itself", saved: ["news", "credit"], loaded: ["news", "credit"], resaved: ["news", "credit"] },
    { name: "two successors off stay themselves", saved: ["credit", "earnings"], loaded: ["credit", "earnings"], resaved: ["credit", "earnings"] },
    {
      name: "an older app turning Macro off over one successor already off",
      saved: ["credit", "macro"],
      loaded: ["credit", "rates-macro", "earnings"],
      resaved: ["macro"],
    },
  ])("$name", ({ saved, loaded, resaved }) => {
    expect(load(saved)).toEqual(loaded);
    expect(save(load(saved))).toEqual(resaved);
    // Loading what was saved changes nothing, however often it goes round.
    expect(load(save(load(saved))).sort()).toEqual([...loaded].sort());
    expect(save(load(save(load(saved))))).toEqual(resaved);
  });

  test("an older app turning Macro back on brings all three back", () => {
    const written = save([...MACRO, "news"]);
    expect(written).toEqual(["macro", "news"]);
    // The older app knows only `macro`, and drops it.
    expect(load(written.filter((pluginId) => pluginId !== "macro"))).toEqual(["news"]);
  });

  test("migrations read macro before it is expanded", () => {
    // The IPO Calendar was a Macro module: a config from before it moved out
    // keeps it off where Macro was off, which the migration sees only as `macro`.
    expect(load(["macro"], 22)).toEqual([...MACRO, "ipo-calendar"]);
  });

  test("a saved Macro workspace loads as it was", () => {
    const instances = ["econ-calendar", "cds", "earnings-calendar"]
      .map((paneId) => createPaneInstance(paneId, { instanceId: `${paneId}:main`, binding: { kind: "none" } }));
    const floating = instances.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: 0, width: 40, height: 10, zIndex: index }));
    const layout = { dockRoot: null, instances, floating, detached: [] };
    const paneState = { "cds:main": { pluginState: { macro: { "cds:tenor": "10y" } } } };
    const saved = {
      ...createDefaultConfig("/gloom"),
      layout,
      layouts: [{ name: "Macro", layout, paneState }],
      pluginConfig: { macro: { "yield-curve:forward": "1y" } },
    };
    const { config } = normalizeLoadedConfig(saved, "/gloom");
    expect(config.layout.instances.map((instance) => instance.instanceId)).toEqual(["econ-calendar:main", "cds:main", "earnings-calendar:main"]);
    expect(config.layouts[0]?.paneState).toEqual(paneState);
    expect(config.pluginConfig).toEqual({ macro: { "yield-curve:forward": "1y" } });
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
