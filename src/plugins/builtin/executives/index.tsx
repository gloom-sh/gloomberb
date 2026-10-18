import type { PluginModule } from "../plugin-module";
import { proLockNote } from "../shared/pro-lock-note";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachExecutivesPersistence,
  resetExecutivesPersistence,
} from "./data";
import { EXECUTIVES_PANE_ID, ExecutivesPane, ExecutivesResearchTab } from "./pane";
import { isKnownNonUsListing } from "../../../utils/sec";

const description =
  "Named executive officers and what they were paid, read from the company's proxy statement and checked against the filing.";

/**
 * EXEC is Pro whole (`useProFeatureWall`). The proxy statements it reads are
 * in the SEC filing list, which needs no account: `filings` lists them with a
 * link to each, where the Summary Compensation Table is the pay as filed,
 * without EXEC's parsed figures.
 */
function executivesLockNote(lock: { gate: "sign-in" | "pro"; symbol: string | null }): string {
  return proLockNote(lock, {
    token: "EXEC",
    does: "it reads each proxy statement into the named executive officers and what they were paid",
    shows: "it",
    free: (ticker, company) => `gloomberb filings ${ticker} --form DEF14A lists ${company}'s proxy statements, each with its filing date and a link to the filing, whose Summary Compensation Table holds the pay as filed.`,
  });
}

export const executivesModule: PluginModule = {
  setup(ctx) {
    attachExecutivesPersistence(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "executives",
      name: "Exec",
      order: 35,
      component: ExecutivesResearchTab,
      instruments: ["equity"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
  },

  dispose() {
    resetExecutivesPersistence();
  },

  panes: [
    {
      id: EXECUTIVES_PANE_ID,
      reportFreshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "proxy statements" },
      reportLockNote: executivesLockNote,
      reportRequirements: ["Gloom Cloud Pro"],
      name: "Executives",
      icon: "X",
      component: ExecutivesPane,
      defaultPosition: "right",
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "executives-pane",
      paneId: EXECUTIVES_PANE_ID,
      label: "Executives",
      description,
      keywords: [
        "executive",
        "executives",
        "exec",
        "ceo",
        "compensation",
        "pay",
        "proxy",
        "def 14a",
        "salary",
      ],
      shortcut: "EXEC",
      publicShare: false,
    }),
  ],
};
