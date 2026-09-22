import type { PluginModule } from "../plugin-module";
import { equityScreenerHeadless } from "./headless";
import { EquityScreenerPane } from "./pane";

export const equityScreenerModule: PluginModule = {
  panes: [
    {
      id: "equity-screener",
      name: "Equity Screener",
      icon: "S",
      component: EquityScreenerPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 108, height: 30 },
      tableExport: true,
      headless: equityScreenerHeadless,
    },
  ],
  paneTemplates: [
    {
      id: "equity-screener-pane",
      paneId: "equity-screener",
      label: "Equity Screener",
      description:
        "Screen stored equities by valuation, growth, liquidity and reported activity; save criteria to your Cloud account.",
      keywords: [
        "eqs",
        "criteria",
        "screener",
        "valuation",
        "discovery",
        "filter",
      ],
      shortcut: { prefix: "EQS" },
      headless: equityScreenerHeadless,
    },
  ],
};
