import type { PaneSettingsDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { DEFAULT_FLOW_FILTERS, FLOW_FILTER_OPTIONS } from "./flow-model";
import FlowPane from "./flow-pane";
import HiloPane from "./hilo-pane";
import { hiloHeadless } from "./headless";

export { hiloHeadless } from "./headless";

export const HILO_PANE_ID = "scanner-hilo";
export const FLOW_PANE_ID = "scanner-flow";

function hiloSettings(): PaneSettingsDef {
  return {
    title: "New Highs / Lows Settings",
    fields: [
      {
        key: "minPrice",
        label: "Minimum price",
        description: "Sub-dollar names otherwise dominate both lists.",
        type: "select",
        options: [
          { value: "off", label: "No filter" },
          { value: "1", label: "$1" },
          { value: "5", label: "$5" },
        ],
      },
      {
        key: "sort",
        label: "Sort",
        type: "select",
        options: [
          { value: "recent", label: "Most recent" },
          { value: "count", label: "Highest count" },
        ],
      },
    ],
  };
}

function toSettingOptions(
  options: readonly { value: string; label: string }[],
): { value: string; label: string }[] {
  return options.map(({ value, label }) => ({ value, label }));
}

function flowSettings(): PaneSettingsDef {
  return {
    title: "Options Flow Settings",
    // Options come from the pane's own filter chips so the two never drift.
    fields: [
      { key: "minPremium", label: "Minimum premium", type: "select", options: toSettingOptions(FLOW_FILTER_OPTIONS.minPremium) },
      { key: "side", label: "Contract side", type: "select", options: toSettingOptions(FLOW_FILTER_OPTIONS.side) },
      { key: "kind", label: "Print kind", type: "select", options: toSettingOptions(FLOW_FILTER_OPTIONS.kind) },
      { key: "volOi", label: "Volume / open interest floor", type: "select", options: toSettingOptions(FLOW_FILTER_OPTIONS.volOi) },
      { key: "expiry", label: "Expiry window", type: "select", options: toSettingOptions(FLOW_FILTER_OPTIONS.expiry) },
      {
        key: "universe",
        label: "Universe",
        description: "Watchlist mode filters the same shared feed locally.",
        type: "select",
        options: toSettingOptions(FLOW_FILTER_OPTIONS.universe),
      },
    ],
  };
}

export const scannerModule: PluginModule = {
  panes: [
    {
      id: HILO_PANE_ID,
      name: "New Highs / Lows",
      icon: "H",
      component: HiloPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 76, height: 26 },
      tableExport: true,
      settings: hiloSettings(),
    },
    {
      id: FLOW_PANE_ID,
      name: "Options Flow",
      icon: "F",
      component: FlowPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 88, height: 28 },
      tableExport: true,
      settings: flowSettings(),
    },
  ],

  paneTemplates: [
    {
      id: "scanner-hilo-pane",
      paneId: HILO_PANE_ID,
      label: "New Highs / Lows",
      description: "Session new-high and new-low momentum with 30s/1m/5m counts.",
      keywords: ["hilo", "highs", "lows", "new", "momentum", "breakout", "scanner"],
      shortcut: { prefix: "HILO" },
      headless: hiloHeadless,
      createInstance: () => ({ settings: { minPrice: "1", sort: "recent" } }),
    },
    {
      id: "scanner-flow-pane",
      paneId: FLOW_PANE_ID,
      label: "Options Flow",
      description: "Unusual options activity: sweeps, blocks, and large premium prints.",
      keywords: ["flow", "options", "sweep", "block", "unusual", "premium", "scanner"],
      shortcut: { prefix: "FLOW" },
      createInstance: () => ({ settings: { ...DEFAULT_FLOW_FILTERS } }),
    },
  ],
};
