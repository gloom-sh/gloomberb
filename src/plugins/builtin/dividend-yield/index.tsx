import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachDividendYieldHealth,
  resetDividendYieldHealth,
  YAHOO_DIVIDENDS_CONNECTION_ID,
} from "./client";
import { DividendYieldPane } from "./pane";
import { dividendYieldHeadless } from "./headless";

export function createDividendYieldModule({
  component = DividendYieldPane,
  headless = dividendYieldHeadless,
  yahooConnection = true,
}: {
  component?: typeof DividendYieldPane;
  headless?: typeof dividendYieldHeadless;
  yahooConnection?: boolean;
} = {}): PluginModule {
  let disposeConnection: (() => void) | null = null;
  return {
    setup(ctx) {
      if (yahooConnection) {
        attachDividendYieldHealth(ctx.connectionHealth);
        disposeConnection = ctx.connectionHealth.registerSource({
          id: YAHOO_DIVIDENDS_CONNECTION_ID,
          name: "Yahoo Finance Dividends",
          kind: "api",
          ownerId: "ticker-research",
          detail: "finance.yahoo.com",
          priority: 300,
        });
      }

      ctx.registerTickerResearchTab({
        id: "dividend-yield",
        name: "Dividends",
        order: 38,
        component,
        isVisible: ({ ticker }) => !!ticker,
      });
    },

    dispose() {
      disposeConnection?.();
      disposeConnection = null;
      if (yahooConnection) resetDividendYieldHealth();
    },

    panes: [
      {
        id: "dividend-yield",
        name: "Dividend Yield",
        icon: "D",
        component,
        defaultPosition: "right",
        defaultMode: "floating",
        defaultFloatingSize: { width: 90, height: 28 },
        tableExport: true,
      },
    ],

    paneTemplates: [
      {
        ...createTickerSurfacePaneTemplate({
          id: "dividend-yield-pane",
          paneId: "dividend-yield",
          label: "Dividend Yield",
          description: "Cash distribution history, trailing cash yield, indicated rates when available, and growth. Future payments are not forecast.",
          keywords: ["dividend", "yield", "dvd", "income", "payout", "ex-date", "distribution"],
          shortcut: "DVD",
        }),
        headless,
      },
    ],
  };
}

export const dividendYieldModule = createDividendYieldModule();
