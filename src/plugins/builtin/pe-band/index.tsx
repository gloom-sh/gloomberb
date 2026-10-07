import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { peBandHeadless } from "./headless";
import { LOOKBACK_OPTIONS, PeBandPane } from "./pane";

export const peBandModule: PluginModule = {
  panes: [{
    id: "pe-band", name: "P/E Band", icon: "P", component: PeBandPane,
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 90, height: 30 },
    tableExport: true,
    settings: { title: "P/E Band Settings", fields: [
      { key: "lookbackYears", label: "Lookback", type: "select", options: LOOKBACK_OPTIONS },
    ] },
  }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({
    id: "pe-band-pane", paneId: "pe-band", label: "P/E Band",
    description: "Price against round multiples of trailing EPS, and where today's P/E ranks in the stock's own history.",
    keywords: ["peb", "pe band", "p/e band", "pe bands", "valuation band", "pe history", "historical pe", "trailing pe"], shortcut: "PEB", publicShare: true,
  }), headless: peBandHeadless }],
};
