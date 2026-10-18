import type { PluginModule } from "../plugin-module";
import { proLockNote } from "../shared/pro-lock-note";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { FILING_EVENTS_PANE_ID, FilingEventsPane } from "./pane";
import { isKnownNonUsListing } from "../../../utils/sec";

const description =
  "The company's 8-K filings, classified by item and read: agreements, executive changes, auditor changes, restructurings, and what each said.";

/**
 * EK is Pro whole (`useProFeatureWall`): signed out it shows the sign-in wall
 * and on a free account the Pro wall, never a partial feed. The 8-Ks themselves
 * are in SEC, which needs no account: its rows carry each 8-K's filing date,
 * acceptance time and items, by number and in words.
 */
function filingEventsLockNote(lock: { gate: "sign-in" | "pro"; symbol: string | null }): string {
  return proLockNote(lock, {
    token: "EK",
    does: "it reads each 8-K and sums up what it said and who it names",
    shows: "them",
    free: (ticker, company) => `gloomberb fn SEC ${ticker} lists ${company}'s recent filings, 8-Ks among them, each with its filing date and its items by number and name.`,
  });
}

export const filingEventsModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "filing-events",
      name: "8-K",
      order: 37,
      component: FilingEventsPane,
      instruments: ["equity"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
  },

  panes: [
    {
      id: FILING_EVENTS_PANE_ID,
      reportFreshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "filed data" },
      reportLockNote: filingEventsLockNote,
      reportRequirements: ["Gloom Cloud Pro"],
      name: "8-K Filings",
      icon: "K",
      component: FilingEventsPane,
      defaultPosition: "right",
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "filing-events-pane",
      paneId: FILING_EVENTS_PANE_ID,
      label: "8-K Filings",
      description,
      keywords: [
        "8-k",
        "8k",
        "current report",
        "events",
        "material",
        "filings",
        "executive change",
      ],
      shortcut: "EK",
      publicShare: false,
    }),
  ],
};
