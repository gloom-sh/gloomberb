import type { GloomPlugin } from "../../../types/plugin";
import { MARKET_HALTS_PANE_ID } from "./model";
import { MarketHaltsPane } from "./pane";

export const marketHaltsPlugin: GloomPlugin = {
  id: "market-halts",
  name: "Market Halts",
  version: "1.0.0",
  description: "Current and recent US trading halts from Nasdaq Trader",
  toggleable: true,

  // An RSS feed over HTTPS, so every renderer. Nasdaq Trader sends no CORS
  // headers, which is why the host is declared: the web app proxies it.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["nasdaqtrader.com"],

  panes: [
    {
      id: MARKET_HALTS_PANE_ID,
      reportFreshness: { source: "Nasdaq Trader" },
      name: "Market Halts",
      icon: "H",
      component: MarketHaltsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 124, height: 26 },
      tableExport: true,
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
