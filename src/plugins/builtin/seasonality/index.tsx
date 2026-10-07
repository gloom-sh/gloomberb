import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { seasonalityHeadless } from "./headless";
import { LOOKBACK_OPTIONS, SeasonalityPane } from "./pane";

export const seasonalityModule: PluginModule = {
  panes: [{
    id: "seasonality", name: "Seasonality", icon: "S", component: SeasonalityPane,
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 112, height: 30 },
    tableExport: true,
    settings: { title: "Seasonality Settings", fields: [
      { key: "lookbackYears", label: "Lookback", type: "select", options: LOOKBACK_OPTIONS },
    ] },
  }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({
    id: "seasonality-pane", paneId: "seasonality", label: "Seasonality",
    description: "Monthly returns by year, each month's average and hit rate, and every year's path on one calendar.",
    keywords: ["seas", "seasonality", "seasonal", "monthly returns", "calendar"], shortcut: "SEAS", publicShare: true,
  }), headless: seasonalityHeadless }],
};
