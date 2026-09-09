import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachRiskFactorsPersistence,
  resetRiskFactorsPersistence,
} from "./data";
import { RISK_FACTORS_PANE_ID, RiskFactorsPane } from "./pane";

const description =
  "The company's 10-K risk factors, and what was added, dropped, or rewritten since the prior year.";

export const riskFactorsModule: PluginModule = {
  setup(ctx) {
    attachRiskFactorsPersistence(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "risk-factors",
      name: "Risks",
      order: 36,
      component: RiskFactorsPane,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  dispose() {
    resetRiskFactorsPersistence();
  },

  panes: [
    {
      id: RISK_FACTORS_PANE_ID,
      name: "Risk Factors",
      icon: "R",
      component: RiskFactorsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "risk-factors-pane",
      paneId: RISK_FACTORS_PANE_ID,
      label: "Risk Factors",
      description,
      keywords: [
        "risk",
        "risks",
        "risk factors",
        "10-k",
        "annual report",
        "item 1a",
      ],
      shortcut: "RISK",
      publicShare: false,
    }),
  ],
};
