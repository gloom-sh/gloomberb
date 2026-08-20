import type { PluginModule } from "../plugin-module";
import { MARKET_HALTS_PANE_ID } from "./model";
import { MarketHaltsPane } from "./pane";

export const marketHaltsModule: PluginModule = {
  panes: [
    {
      id: MARKET_HALTS_PANE_ID,
      name: "Market Halts",
      icon: "H",
      component: MarketHaltsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 124, height: 26 },
    },
  ],

  paneTemplates: [
    {
      id: "market-halts-pane",
      paneId: MARKET_HALTS_PANE_ID,
      label: "Market Halts",
      description: "Current and recent US trading halts from Nasdaq Trader, with reason and resumption times.",
      keywords: ["halt", "halts", "pause", "luld", "circuit", "breaker", "suspension", "resumption"],
      shortcut: { prefix: "HALT" },
      createInstance: () => ({ placement: "floating" }),
    },
  ],
};
