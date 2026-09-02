import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachShortInterestHealth,
  resetShortInterestHealth,
  YAHOO_SHORT_INTEREST_CONNECTION_ID,
} from "./client";
import { ShortInterestView } from "./pane";

let disposeConnection: (() => void) | null = null;

export const shortInterestModule: PluginModule = {
  setup(ctx) {
    attachShortInterestHealth(ctx.connectionHealth);
    disposeConnection = ctx.connectionHealth.registerSource({
      id: YAHOO_SHORT_INTEREST_CONNECTION_ID,
      name: "Yahoo Finance Short Interest",
      kind: "api",
      ownerId: "ticker-research",
      detail: "finance.yahoo.com",
      priority: 300,
    });

    ctx.registerTickerResearchTab({
      id: "short-interest",
      name: "Short Interest",
      order: 36,
      component: ShortInterestView,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  dispose() {
    disposeConnection?.();
    disposeConnection = null;
    resetShortInterestHealth();
  },

  panes: [
    {
      id: "short-interest",
      name: "Short Interest",
      icon: "S",
      component: ShortInterestView,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 90, height: 25 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "short-interest-pane",
      paneId: "short-interest",
      label: "Short Interest",
      // Yahoo's key-statistics module only carries the current and prior settlement dates.
      description: "Bi-monthly short interest settlements from FINRA with days to cover and average daily volume.",
      keywords: ["short", "interest", "si", "shorts", "borrow", "days", "cover"],
      shortcut: "SI",
    }),
  ],
};
