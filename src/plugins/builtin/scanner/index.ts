import type { PaneSettingsDef } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { DEFAULT_FLOW_FILTERS } from "./flow-model";
import FlowPane from "./flow-pane";
import HiloPane from "./hilo-pane";

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

function flowSettings(): PaneSettingsDef {
  return {
    title: "Options Flow Settings",
    fields: [
      {
        key: "minPremium",
        label: "Minimum premium",
        type: "select",
        options: [
          { value: "50000", label: "$50K" },
          { value: "250000", label: "$250K" },
          { value: "1000000", label: "$1M" },
        ],
      },
      {
        key: "side",
        label: "Contract side",
        type: "select",
        options: [
          { value: "both", label: "Calls and puts" },
          { value: "calls", label: "Calls only" },
          { value: "puts", label: "Puts only" },
        ],
      },
      {
        key: "kind",
        label: "Print kind",
        type: "select",
        options: [
          { value: "all", label: "All prints" },
          { value: "sweeps", label: "Sweeps only" },
          { value: "blocks", label: "Blocks only" },
        ],
      },
      {
        key: "volOi",
        label: "Volume / open interest floor",
        type: "select",
        options: [
          { value: "off", label: "No floor" },
          { value: "1", label: "1x and up" },
          { value: "5", label: "5x and up" },
        ],
      },
      {
        key: "expiry",
        label: "Expiry window",
        type: "select",
        options: [
          { value: "all", label: "Any expiry" },
          { value: "7", label: "7 days or less" },
          { value: "30", label: "30 days or less" },
        ],
      },
      {
        key: "universe",
        label: "Universe",
        description: "Watchlist mode filters the same shared feed locally.",
        type: "select",
        options: [
          { value: "active", label: "Active names" },
          { value: "watchlist", label: "My tickers only" },
        ],
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
