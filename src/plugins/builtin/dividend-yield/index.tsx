import type { PluginModule } from "../plugin-module";
import { DIVIDEND_SERIES } from "./series";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import {
  attachDividendYieldHealth,
  resetDividendYieldHealth,
  DIVIDENDS_CONNECTION_ID,
} from "./client";
import { DividendYieldPane } from "./pane";
import { dividendYieldHeadless } from "./headless";
import { RANK_SYMBOLS_SETTING } from "./ranking-view";
import { MAX_RANKED_SYMBOLS } from "./ranking-reads";
import type { PaneTemplateCreateOptions, PaneTemplateDef } from "../../../types/plugin";

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
    series: DIVIDEND_SERIES,
    setup(ctx) {
      if (marketConnection) {
        attachDividendYieldHealth(ctx.connectionHealth);
        disposeConnection = ctx.connectionHealth.registerSource({
          id: DIVIDENDS_CONNECTION_ID,
          name: "Gloom Dividends",
          kind: "api",
          ownerId: "ticker-core",
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
        ...withRanking(createTickerSurfacePaneTemplate({
          id: "dividend-yield-pane",
          paneId: "dividend-yield",
          label: "Dividend Yield",
          description: "Cash distribution history, trailing and forward yield, payout and growth; gloom fn DVD with several tickers ranks them by yield. "
            + "A bond fund's SEC yield beside its distribution yield, and with --tax-rate a muni fund's tax-equivalent yield. Future payments are not forecast.",
          keywords: ["dividend", "dividends", "yield", "dvd", "income", "payout", "ex-date", "distribution", "dividend income", "income investing",
            "dividend growth", "payout ratio", "drip", "reinvest", "reinvestment", "dividend reinvestment", "rank dividend payers",
            "sec yield", "distribution yield", "muni", "munis", "municipal", "municipal bonds", "tax-exempt", "tax-equivalent yield", "muni treasury ratio"],
          shortcut: "DVD",
        })),
        headless,
      },
    ],
  };
}

/**
 * The tickers a DVD is opened with when there are several: the list a command
 * passes (`shot DVD KO JNJ`), or a comma list typed as its argument.
 */
function rankedSymbols(options: PaneTemplateCreateOptions | undefined): string[] {
  const list = options?.symbols?.length ? options.symbols : (options?.arg ?? options?.symbol ?? "").split(",");
  // The first 25, as `fn DVD` ranks at most.
  const symbols = [...new Set(list.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_RANKED_SYMBOLS);
  return symbols.length > 1 ? symbols : [];
}

/** DVD with several tickers opens one pane that ranks them by yield, as `fn DVD A B C` does; with one, its own pane. */
function withRanking(template: PaneTemplateDef): PaneTemplateDef {
  return {
    ...template,
    // `fn` and `shot` pass a typed list as `symbols`, so `shot DVD KO JNJ` draws the ranking `fn DVD KO JNJ` prints.
    opensTickerList: true,
    canCreate: (context, options) => rankedSymbols(options).length > 1 || (template.canCreate?.(context, options) ?? true),
    createInstance: (context, options) => {
      const symbols = rankedSymbols(options);
      if (symbols.length < 2) return template.createInstance?.(context, options) ?? null;
      return {
        instanceId: `dividend-yield:rank:${symbols.map((symbol) => encodeURIComponent(symbol)).join(",")}`,
        title: `DVD ${symbols.join(", ")}`,
        binding: { kind: "none" },
        placement: "floating",
        settings: { [RANK_SYMBOLS_SETTING]: symbols },
      };
    },
  };
}

export const dividendYieldModule = createDividendYieldModule();
