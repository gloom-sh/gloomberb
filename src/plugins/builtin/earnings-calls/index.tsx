import type { PluginModule } from "../plugin-module";
import { attachEarningsCallsPersistence, resetEarningsCallsPersistence } from "./data";
import { EarningsCallsPane, EARNINGS_CALLS_PANE_ID } from "./pane";
import { earningsCallsHeadless } from "./headless";


const description =
  "Earnings call transcripts with speaker attribution, analyst Q&A, and extracted guidance. Alone, every transcribed call; with a ticker, that company's calls.";

function explicitSymbol(options?: { arg?: string; symbol?: string | null }): string | null {
  const symbol = (options?.symbol ?? options?.arg ?? "").trim().toUpperCase();
  return symbol || null;
}

export const earningsCallsModule: PluginModule = {
  setup(ctx) {
    attachEarningsCallsPersistence(ctx.persistence);

    ctx.registerTickerResearchTab({
      id: "earnings-calls",
      name: "Calls",
      order: 34,
      component: EarningsCallsPane,
      instruments: ["equity"],
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
        "ect",
      ],
      // The ticker is optional on purpose: CALLS alone browses every call,
      // and it must not silently bind to whatever ticker happens to be active.
      shortcut: { prefix: "CALLS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
      headless: earningsCallsHeadless,
      createInstance: (_context, options) => {
        const symbol = explicitSymbol(options);
        if (!symbol) return { placement: "floating" };
        return {
          instanceId: `${EARNINGS_CALLS_PANE_ID}:${encodeURIComponent(symbol).replace(/%/g, "~")}`,
          title: `CALLS ${symbol}`,
          binding: { kind: "fixed", symbol },
          placement: "floating",
        };
      },
    },
  ],
};
