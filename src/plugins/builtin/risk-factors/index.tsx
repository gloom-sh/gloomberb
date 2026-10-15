import type { PluginModule } from "../plugin-module";
import { proLockNote } from "../shared/pro-lock-note";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachRiskFactorsPersistence,
  resetRiskFactorsPersistence,
} from "./data";
import { riskFactorsHeadless } from "./headless";


import { RISK_FACTORS_PANE_ID, RiskFactorsPane, RiskFactorsResearchTab } from "./pane";
import { isKnownNonUsListing } from "../../../utils/sec";

const description =
  "The company's 10-K risk factors, and what was added, dropped, or rewritten since the prior year.";

/**
 * RISK is Pro whole (`useProFeatureWall`). The 10-Ks it reads are in the SEC
 * filing list, which needs no account: `filings` lists them with a link to
 * each, where Item 1A is the risk factors as written, without RISK's grouping
 * or its changes since the year before.
 */
function riskFactorsLockNote(lock: { gate: "sign-in" | "pro"; symbol: string | null }): string {
  return proLockNote(lock, {
    token: "RISK",
    does: "it groups a 10-K's risk factors by theme and shows what was added, dropped or reworded since the year before",
    shows: "it",
    free: (ticker, company) => `gloomberb filings ${ticker} --form 10-K lists ${company}'s annual reports, each with its filing date and a link to the filing, whose Item 1A holds the risk factors as written.`,
  });
}

export const riskFactorsModule: PluginModule = {
  setup(ctx) {
    attachRiskFactorsPersistence(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "risk-factors",
      name: "Risks",
      order: 36,
      component: RiskFactorsResearchTab,
      instruments: ["equity"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
  },

  dispose() {
    resetRiskFactorsPersistence();
  },

  panes: [
    {
      id: RISK_FACTORS_PANE_ID,
      reportLockNote: riskFactorsLockNote,
      reportRequirements: ["Gloom Cloud Pro"],
      name: "Risk Factors",
      icon: "R",
      component: RiskFactorsPane,
      headless: riskFactorsHeadless,
      defaultPosition: "right",
      tickerFollower: true,
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
