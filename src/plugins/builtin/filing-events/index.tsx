import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { FILING_EVENTS_PANE_ID, FilingEventsPane } from "./pane";
import { isKnownNonUsListing } from "../../../utils/sec";

const description =
  "The company's 8-K filings, classified by item and read: agreements, executive changes, auditor changes, restructurings, and what each said.";

/**
 * EK is Pro whole (`useProFeatureWall`): signed out it shows the sign-in wall
 * and on a free account the Pro wall, never a partial feed. The 8-Ks themselves
 * are in SEC, which needs no account: its rows carry each 8-K's filing date,
 * acceptance time and item numbers.
 */
function filingEventsLockNote({ gate, symbol }: { gate: "sign-in" | "pro"; symbol: string | null }): string {
  const ticker = symbol ?? "<ticker>";
  const unlock = gate === "sign-in"
    ? "To read them in EK, open the app (gloomberb), log in or sign up from the command bar (Ctrl+P, Log In or Sign Up), then upgrade (Ctrl+P, UPGRADE)"
    : "To read them in EK, upgrade in the app (gloomberb, then Ctrl+P, UPGRADE)";
  return [
    `EK is part of Gloom Cloud Pro: it classifies each 8-K by item and reads what it said. ${gate === "sign-in" ? "Signed out" : "On a free account"} it shows none of them.`,
    `Free, with no sign-in: gloomberb fn SEC ${ticker} lists ${symbol ?? "the company"}'s recent filings, 8-Ks among them, with their filing dates and item numbers.`,
    `${unlock}; gloomberb fn EK ${ticker} then reads with that session.`,
  ].join("\n");
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
