import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachDividendYieldHealth,
  resetDividendYieldHealth,
  YAHOO_DIVIDENDS_CONNECTION_ID,
} from "./client";
import { DividendYieldPane } from "./pane";

let disposeConnection: (() => void) | null = null;

export const dividendYieldModule: PluginModule = {
  setup(ctx) {
    attachDividendYieldHealth(ctx.connectionHealth);
    disposeConnection = ctx.connectionHealth.registerSource({
      id: YAHOO_DIVIDENDS_CONNECTION_ID,
      name: "Yahoo Finance Dividends",
      kind: "api",
      ownerId: "ticker-research",
      detail: "finance.yahoo.com",
      priority: 300,
    });

    ctx.registerTickerResearchTab({
      id: "dividend-yield",
      name: "Dividends",
      order: 38,
      component: DividendYieldPane,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  dispose() {
    disposeConnection?.();
    disposeConnection = null;
    resetDividendYieldHealth();
  },

  panes: [
    {
      id: "dividend-yield",
      name: "Dividend Yield",
      icon: "D",
      component: DividendYieldPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 28 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "dividend-yield-pane",
      paneId: "dividend-yield",
      label: "Dividend Yield",
      description: "Dividend history, trailing/forward yield, growth rates, and payment schedule.",
      keywords: ["dividend", "yield", "dvd", "income", "payout", "ex-date", "distribution"],
      shortcut: "DVD",
    }),
  ],
};
