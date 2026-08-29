import type { PluginModule } from "../plugin-module";
import { BuffettIndicatorPane } from "./pane";
import { buildBuffettSettingsDef } from "./settings";

export const buffettIndicatorModule: PluginModule = {
  panes: [{
    id: "buffett-indicator",
    name: "Buffett Indicator",
    icon: "B",
    component: BuffettIndicatorPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 84, height: 26 },
    settings: buildBuffettSettingsDef(),
  }],
  paneTemplates: [{
    id: "buffett-indicator-pane",
    paneId: "buffett-indicator",
    label: "Buffett Indicator",
    description: "US total market cap to GDP with valuation zones and trend deviation.",
    keywords: ["buffett", "indicator", "valuation", "market cap", "gdp", "wilshire", "macro", "bubble"],
    shortcut: { prefix: "BUF" },
  }],
};
