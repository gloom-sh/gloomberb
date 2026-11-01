import type { DoeTab } from "../../../api-client/doe";
import type { PaneTemplateCreateOptions, PaneTemplateInstanceConfig } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { DOE_CATALOG_SERIES } from "./series";
import { doeBoardCache } from "./client";
import { doePriceCache } from "./prices";
import { doeGasWord, doeHeadless } from "./headless";
import { DOE_SERIES_OPTIONS, doeSeriesOption } from "./model";

/** Opens on a tab, or on the series typed after the mnemonic and its tab. */
function doeInstance(tab: DoeTab, options?: PaneTemplateCreateOptions): PaneTemplateInstanceConfig {
  const input = options?.arg?.trim();
  // `DOE NGS` or `DOE natural gas` opens on gas storage, as `NGS` does.
  if (input && doeGasWord(input)) return { placement: "floating", settings: { tab: "gas" } };
  const series = doeSeriesOption(input);
  if (input && !series) throw new Error(`Use a series such as cushing, gasoline, distillate or east${tab === "gas" ? "" : "; for gas storage, gloom fn NGS"}`);
  return { placement: "floating", settings: { tab: series?.tab ?? tab }, ...(series ? { params: { series: series.value } } : {}) };
}

const shortcut = (prefix: string, tab: DoeTab | null) => ({
  prefix, argKind: "text" as const, argPlaceholder: "series", argOptional: true,
  argOptions: () => DOE_SERIES_OPTIONS.filter((option) => !tab || option.tab === tab).map(({ value, label }) => ({ value, label })),
});

export const doeModule: PluginModule = {
  series: DOE_CATALOG_SERIES,
  panes: [{ id: "doe", name: "Oil and Gas Inventories", icon: "D", get component(): typeof import("./pane").DoePane { const { DoePane } = require("./pane"); return DoePane; },
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 96, height: 34 },
    tableExport: true, headless: doeHeadless("all") }],
  paneTemplates: [{
    id: "doe-pane", paneId: "doe", label: "Oil and Gas Inventories",
    description: "EIA weekly petroleum and gas storage: builds and draws, year-ago and five-year ranges, seasonal charts.",
    keywords: ["doe", "eia", "oil", "crude", "cushing", "spr", "gasoline", "distillate", "inventories", "stocks", "refinery"],
    shortcut: shortcut("DOE", null), headless: doeHeadless("all"),
    createInstance: (_context, options) => doeInstance("crude", options),
  }, {
    id: "doe-gas-pane", paneId: "doe", label: "Natural Gas Storage",
    description: "EIA weekly working gas in storage, lower 48 and by region, against a year ago and the five-year range.",
    keywords: ["ngs", "natural gas", "storage", "working gas", "injection", "withdrawal", "eia"],
    shortcut: shortcut("NGS", "gas"), headless: doeHeadless("gas"),
    createInstance: (_context, options) => doeInstance("gas", options),
  }],
  setup(ctx) {
    doeBoardCache.attach(ctx.persistence);
    doePriceCache.attach(ctx.persistence);
  },
  dispose() {
    doeBoardCache.reset();
    doePriceCache.reset();
  },
};
