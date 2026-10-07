import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { macroDayHeadless } from "./headless";
import { LOOKBACK_OPTIONS, MacroDayPane } from "./pane";

export const macroDayModule: PluginModule = {
  panes: [{
    id: "macro-day", name: "Macro-Day Reaction", icon: "M", component: MacroDayPane,
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 76, height: 26 },
    tableExport: true,
    settings: { title: "Macro-Day Reaction Settings", fields: [
      { key: "lookbackYears", label: "Lookback", type: "select", options: LOOKBACK_OPTIONS },
    ] },
  }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({
    id: "macro-day-pane", paneId: "macro-day", label: "Macro-Day Reaction",
    description: "How a name moves on CPI, jobs and FOMC days against a normal day: average move, direction, hit rate and every release day.",
    keywords: ["mday", "macro day", "cpi day", "fomc day", "jobs day", "nfp", "payrolls", "event study", "release reaction"],
    shortcut: "MDAY", publicShare: true,
  }), headless: macroDayHeadless }],
};
