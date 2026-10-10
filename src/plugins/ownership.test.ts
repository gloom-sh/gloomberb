import { afterEach, describe, expect, test } from "bun:test";
import { normalizeConfigForSave, normalizeLoadedConfig } from "../data/config/store/normalize";
import { CURRENT_CONFIG_VERSION, createDefaultConfig } from "../types/config";
import { encodeBuiltinDisabledPluginIds, expandBuiltinPluginGroups, setBuiltinPluginGroupsForTests } from "./ownership";

// Shaped like the planned split: two retired ids whose groups share members.
const GROUPS = {
  macro: ["rates-macro", "credit", "earnings"],
  "ticker-research": ["ticker-core", "options-volatility", "credit", "earnings"],
};

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

describe("disabled plugin groups", () => {
  test.each([
    { name: "an old id alone turns off its whole group", saved: ["macro"], loaded: ["rates-macro", "credit", "earnings"], resaved: ["macro"] },
    { name: "a group partly off stays as its members", saved: ["news", "credit"], loaded: ["news", "credit"], resaved: ["news", "credit"] },
    {
      name: "an older app turning the old plugin off over a partial group",
      saved: ["credit", "macro"],
      loaded: ["credit", "rates-macro", "earnings"],
      resaved: ["macro"],
    },
    {
      name: "overlapping groups both off",
      saved: ["ticker-research", "macro"],
      loaded: ["ticker-core", "options-volatility", "credit", "earnings", "rates-macro"],
      resaved: ["ticker-research", "macro"],
    },
    {
      name: "one of two overlapping groups off",
      saved: ["ticker-research"],
      loaded: ["ticker-core", "options-volatility", "credit", "earnings"],
      resaved: ["ticker-research"],
    },
  ])("$name", ({ saved, loaded, resaved }) => {
    setBuiltinPluginGroupsForTests(GROUPS);
    expect(load(saved)).toEqual(loaded);
    expect(save(load(saved))).toEqual(resaved);
    // Loading what was saved changes nothing, however often it goes round.
    expect(load(save(load(saved))).sort()).toEqual([...loaded].sort());
    expect(save(load(save(load(saved))))).toEqual(resaved);
  });

  test("expanding what was encoded gives back the same switched-off plugins", () => {
    setBuiltinPluginGroupsForTests(GROUPS);
    for (const disabled of [
      [],
      ["credit"],
      ["rates-macro", "credit", "earnings"],
      ["earnings", "external-plugin", "credit", "rates-macro"],
      ["ticker-core", "options-volatility", "credit", "earnings", "rates-macro", "news"],
      ["ticker-core", "options-volatility", "credit"],
    ]) {
      expect(expandBuiltinPluginGroups(encodeBuiltinDisabledPluginIds(disabled)).sort()).toEqual([...disabled].sort());
    }
  });

  test("an older app turning the old plugin back on brings every member back", () => {
    setBuiltinPluginGroupsForTests(GROUPS);
    const written = save(["rates-macro", "credit", "earnings", "news"]);
    expect(written).toEqual(["macro", "news"]);
    // The older app knows only `macro`, and drops it.
    expect(load(written.filter((pluginId) => pluginId !== "macro"))).toEqual(["news"]);
  });

  test("migrations read the old id before it is expanded", () => {
    setBuiltinPluginGroupsForTests(GROUPS);
    // The IPO Calendar was a Macro module: a config from before it moved out
    // keeps it off where Macro was off, which the migration sees only as `macro`.
    expect(load(["macro"], 22)).toEqual(["rates-macro", "credit", "earnings", "ipo-calendar"]);
  });
});
