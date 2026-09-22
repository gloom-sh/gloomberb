import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { OptionsScenarioPane } from "./pane";
import { optionsScenarioHeadless } from "./headless";

const scenarioSettingKeys = ["legs", "strategy", "expiration", "spot", "rate", "dividendYield", "currency", "asOf", "date", "volShift", "spotRange", "seedLeg"];

export const optionsScenarioModule: PluginModule = {
  panes: [{
    id: "options-scenario", name: "Options Scenario", icon: "V", component: OptionsScenarioPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 126, height: 36 },
    tableExport: true, headless: optionsScenarioHeadless,
    settings: {
      title: "Options Scenario Settings",
      fields: [
        { key: "spotRange", label: "Spot grid range (%)", type: "text" },
      ],
    },
  }],
  paneTemplates: [createTickerSurfacePaneTemplate({
    id: "options-scenario-pane", paneId: "options-scenario", label: "Options Scenario",
    description: "Build multi-leg positions and compare scenario P&L, payoff and aggregate Greeks.",
    keywords: ["osa", "options", "scenario", "payoff", "strategy", "greeks"],
    shortcut: "OSA", publicShare: true,
    settings: (symbol, _context, options) => ({ symbol, ...Object.fromEntries(scenarioSettingKeys
      .filter((key) => options?.values?.[key] != null).map((key) => [key, options!.values![key]])) }),
  })],
};
