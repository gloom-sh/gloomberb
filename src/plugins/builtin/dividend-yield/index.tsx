import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachDividendYieldHealth,
  resetDividendYieldHealth,
  DIVIDENDS_CONNECTION_ID,
} from "./client";
import { DividendYieldPane } from "./pane";
import { dividendYieldHeadless } from "./headless";

function createDividendYieldModule({
  component = DividendYieldPane,
  headless = dividendYieldHeadless,
  marketConnection = true,
}: {
  component?: typeof DividendYieldPane;
  headless?: typeof dividendYieldHeadless;
  marketConnection?: boolean;
} = {}): PluginModule {
  let disposeConnection: (() => void) | null = null;
  return {
    setup(ctx) {
      if (marketConnection) {
        attachDividendYieldHealth(ctx.connectionHealth);
        disposeConnection = ctx.connectionHealth.registerSource({
          id: DIVIDENDS_CONNECTION_ID,
          name: "Gloom Dividends",
          kind: "api",
          ownerId: "ticker-research",
          detail: "api.gloom.sh",
          priority: 300,
        });
      }

      ctx.registerTickerResearchTab({
        id: "dividend-yield",
        name: "Dividends",
        order: 38,
        component,
        instruments: ["equity", "fund"],
      });
    },

    dispose() {
      disposeConnection?.();
      disposeConnection = null;
      if (marketConnection) resetDividendYieldHealth();
    },

    panes: [
      {
        id: "dividend-yield",
        name: "Dividend Yield",
        icon: "D",
        component,
        defaultPosition: "right",
        tickerFollower: true,
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
