import { describe, expect, test } from "bun:test";
import { applyPluginToggles, regroupedBuiltinPluginIds } from "../../ownership";
import {
  matchingPack,
  PACK_PLUGIN_IDS,
  packChange,
  packToggles,
  restoreToggles,
  STARTER_PACKS,
  type StarterPack,
} from "./packs";

const pack = (id: string): StarterPack => STARTER_PACKS.find((candidate) => candidate.id === id)!;

/** What `setPluginsEnabled` leaves in `disabledPlugins` for a set of switches. */
const apply = (disabled: readonly string[], toggles: Record<string, boolean>) => applyPluginToggles(disabled, toggles) ?? [...disabled];

describe("starter packs", () => {
  test("switch exactly the plugins the old groups were split into, and keep Ticker Research on", () => {
    expect([...PACK_PLUGIN_IDS].sort()).toEqual(regroupedBuiltinPluginIds().sort());
    for (const candidate of STARTER_PACKS) {
      expect(candidate.plugins).toContain("ticker-core");
      expect(candidate.plugins.every((id) => PACK_PLUGIN_IDS.includes(id))).toBe(true);
    }
  });

  test("say what goes off, comes on and stays, and leave other and installed plugins alone", () => {
    // News and an installed plugin are off; Credit is off from an earlier choice.
    const disabled = ["news", "gloom-tv", "credit"];
    const change = packChange(disabled, pack("options-desk"));
    expect(change.turnOff).toEqual(["ownership", "filings", "rates-macro", "global-markets", "futures-commodities", "crypto", "alt-data"]);
    expect(change.turnOn).toEqual([]);
    expect(change.keep).toEqual(["ticker-core", "options-volatility", "earnings", "screeners", "quant"]);

    const toggles = packToggles(packChange(disabled, pack("credit-bonds")));
    expect(toggles).toEqual({ "options-volatility": false, ownership: false, credit: true, "global-markets": false, screeners: false, "futures-commodities": false, crypto: false, "alt-data": false, quant: false });
    const after = apply(disabled, toggles);
    expect(after).toContain("news");
    expect(after).toContain("gloom-tv");
  });

  test("a pack matches only the exact set it keeps on, whatever else is off", () => {
    expect(matchingPack([])?.id).toBe("everything");
    expect(matchingPack(["news", "gloom-tv"])?.id).toBe("everything");
    const optionsDesk = apply(["news"], packToggles(packChange(["news"], pack("options-desk"))));
    expect(matchingPack(optionsDesk)?.id).toBe("options-desk");
    expect(matchingPack([...optionsDesk.filter((id) => id !== "crypto")])).toBeNull();
  });

  test("applying a pack twice changes nothing the second time", () => {
    const once = apply(["news"], packToggles(packChange(["news"], pack("macro-rates"))));
    expect(packToggles(packChange(once, pack("macro-rates")))).toEqual({});
    expect(applyPluginToggles(once, packToggles(packChange(once, pack("macro-rates"))))).toBeNull();
  });

  test("Undo puts back the plugins that were off before, and only those", () => {
    for (const previous of [[], ["news", "credit", "crypto"], ["alt-data", "gloom-tv"]]) {
      for (const candidate of STARTER_PACKS) {
        const applied = apply(previous, packToggles(packChange(previous, candidate)));
        const undone = apply(applied, restoreToggles(previous));
        expect([...undone].sort()).toEqual([...previous].sort());
      }
    }
  });
});
