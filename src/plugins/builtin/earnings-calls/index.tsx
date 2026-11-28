import type { PluginModule } from "../plugin-module";
import { createOptionalTickerPaneTemplate } from "../shared/ticker-surface";
import { attachEarningsCallsPersistence, resetEarningsCallsPersistence } from "./data";
import { EarningsCallsPane, EARNINGS_CALLS_PANE_ID } from "./pane";
import { earningsCallsHeadless } from "./headless";
import { callsLockNote } from "./lock-note";

const description =
  "Pro earnings call transcripts with speaker attribution, analyst Q&A, and extracted guidance. Alone, the calendar of upcoming calls this week; with a ticker, that company's calls, its next one first.";

export const earningsCallsModule: PluginModule = {
  setup(ctx) {
    attachEarningsCallsPersistence(ctx.persistence);

    ctx.registerTickerResearchTab({
      id: "earnings-calls",
      name: "Calls",
      order: 34,
      component: EarningsCallsPane,
      instruments: ["equity"],
      proOnly: true,
    });
  },

  dispose() {
    resetEarningsCallsPersistence();
  },

  panes: [
    {
      id: EARNINGS_CALLS_PANE_ID,
      reportLockNote: callsLockNote,
      name: "Earnings Calls",
      icon: "C",
      component: EarningsCallsPane,
      defaultPosition: "right",
      shareItem: { ticker: true },
      tickerFollower: true,
      instruments: ["equity"],
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    // The ticker is optional on purpose: CALLS alone is the calendar of every
    // company's calls, and it must not silently bind to whatever ticker happens to be active.
    createOptionalTickerPaneTemplate({
      id: "earnings-calls-pane",
      paneId: EARNINGS_CALLS_PANE_ID,
      label: "Earnings Calls",
      description,
      keywords: ["earnings", "call", "calls", "transcript", "transcripts", "conference", "guidance", "qa", "ect"],
      shortcut: "CALLS",
      headless: earningsCallsHeadless,
    }),
  ],
};
