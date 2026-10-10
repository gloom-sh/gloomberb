import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { OptionsScenarioPane } from "./pane";
import { optionsScenarioHeadless } from "./headless";

const scenarioSettingKeys = ["legs", "strategy", "strike", "expiration", "spot", "rate", "dividendYield", "currency", "asOf", "date", "volShift",
  "spotRange", "seedLeg", "nav", "budgetBps", "sleeve"];

export const optionsScenarioModule: PluginModule = {
  panes: [{
    id: "options-scenario", name: "Options Scenario", icon: "V", component: OptionsScenarioPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 126, height: 36 },
    tableExport: true, headless: optionsScenarioHeadless,
    settings: {
      title: "Options Scenario Settings",
      fields: [
        { key: "spotRange", label: "Spot grid range (%)", type: "text" },
        { key: "nav", label: "Hedge NAV", type: "text", placeholder: "100m",
          description: "Portfolio NAV a hedge budget is a share of, such as 100m, 2.5bn or 1,000,000. Set with a budget to size the position." },
        { key: "budgetBps", label: "Hedge budget (bps)", type: "text", placeholder: "50",
          description: "Share of NAV to spend on the position, in basis points: 50 is 0.5%." },
        { key: "sleeve", label: "Equity sleeve", type: "text", placeholder: "100m",
          description: "The equity the hedge protects, for coverage: notional protected over the sleeve." },
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
