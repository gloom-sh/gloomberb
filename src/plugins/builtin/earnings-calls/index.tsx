import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { attachEarningsCallsPersistence, resetEarningsCallsPersistence } from "./data";
import { EarningsCallsPane, EARNINGS_CALLS_PANE_ID } from "./pane";

const description =
  "Earnings call transcripts with speaker attribution, analyst Q&A, and extracted guidance.";

export const earningsCallsModule: PluginModule = {
  setup(ctx) {
    attachEarningsCallsPersistence(ctx.persistence);

    ctx.registerTickerResearchTab({
      id: "earnings-calls",
      name: "Calls",
      order: 34,
      component: EarningsCallsPane,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  dispose() {
    resetEarningsCallsPersistence();
  },

  panes: [
    {
      id: EARNINGS_CALLS_PANE_ID,
      name: "Earnings Calls",
      icon: "C",
      component: EarningsCallsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    // Browse every transcribed call, unbound to a ticker.
    {
      id: "earnings-calls-pane",
      paneId: EARNINGS_CALLS_PANE_ID,
      label: "Earnings Calls",
      description,
      keywords: [
        "earnings",
        "call",
        "calls",
        "transcript",
        "transcripts",
        "conference",
        "guidance",
        "qa",
      ],
      shortcut: { prefix: "CALLS" },
      createInstance: () => ({ placement: "floating" }),
    },
    createTickerSurfacePaneTemplate({
      id: "earnings-call-transcripts-pane",
      paneId: EARNINGS_CALLS_PANE_ID,
      label: "Earnings Call Transcripts",
      description,
      keywords: ["earnings", "call", "transcript", "ect", "qa", "guidance"],
      shortcut: "ECT",
      publicShare: false,
    }),
  ],
};
