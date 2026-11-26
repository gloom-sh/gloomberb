import type { PaneTemplateContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { commandTabParams, withCommandTab } from "../shared/command-tab";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { beneficialOwnersCache } from "./beneficial-client";
import { CCASS_MARKET_PANE_ID, CCASS_MARKET_TEMPLATE_ID } from "./ccass-market-pane";
import { holdersHeadless } from "./headless";

export const holdersModule: PluginModule = {
  setup(ctx) {
    beneficialOwnersCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "holders",
      name: "Holders",
      order: 42,
      get component(): typeof import("./pane").HoldersView { const { HoldersView } = require("./pane"); return HoldersView; },
      instruments: ["equity"],
    });
  },
  dispose() {
    beneficialOwnersCache.reset();
  },

  panes: [
    {
      id: "holders",
      name: "Holders",
      icon: "H",
      get component(): typeof import("./pane").HoldersView { const { HoldersView } = require("./pane"); return HoldersView; },
      defaultPosition: "right",
      shareItem: { ticker: true },
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 105, height: 34 },
      tableExport: true,
    },
    {
      id: CCASS_MARKET_PANE_ID,
      name: "HK CCASS",
      icon: "C",
      get component(): typeof import("./ccass-market-pane").CcassMarketPane {
        const { CcassMarketPane } = require("./ccass-market-pane");
        return CcassMarketPane;
      },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 108, height: 32 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "holders-pane",
        paneId: "holders",
        label: "Holders",
        description: "Institutional holders from 13F filings, 13D/13G beneficial owners, exchange disclosures and Hong Kong CCASS custody.",
        keywords: [
          "holders", "ownership", "institutional", "owners", "hds",
          "13d", "13g", "13d/g", "schedule 13d", "schedule 13g", "beneficial owners", "beneficial ownership", "activist", "activists",
        ],
        shortcut: "HDS",
      }),
      headless: holdersHeadless,
    },
    (() => {
      const ccassTemplate = withCommandTab(
        createTickerSurfacePaneTemplate({
          id: "ccass-pane",
          paneId: "holders",
          label: "Hong Kong CCASS Custody",
          description: "Daily HKEX CCASS broker custody holdings, bucketed flows and pre-placement deposits for Hong Kong stocks and dual-listed China ADRs.",
          keywords: [
            "ccass", "hkex", "custody", "brokers", "southbound", "stock connect", "hong kong", "webb-site",
          ],
          shortcut: "CCASS",
        }),
        "ccass",
      );
      const withDefaultHk = (context: PaneTemplateContext): PaneTemplateContext =>
        context.activeTicker ? context : { ...context, activeTicker: "0700.HK" };
      return {
        ...ccassTemplate,
        canCreate: (context, createOptions) => ccassTemplate.canCreate?.(withDefaultHk(context), createOptions) ?? true,
        createInstance: (context, createOptions) => ccassTemplate.createInstance?.(withDefaultHk(context), createOptions) ?? null,
      };
    })(),
    {
      id: CCASS_MARKET_TEMPLATE_ID,
      paneId: CCASS_MARKET_PANE_ID,
      label: "HK CCASS Scanner",
      description: "Market-wide Hong Kong CCASS big changes, pre-placement deposits, Top-10 concentration rankings, Southbound Connect flows and broker portfolio lookup.",
      keywords: [
        "ccass", "ccass big", "ccass conc", "deposits", "southbound", "concentration", "hkex brokers", "futu", "hong kong",
      ],
      shortcut: {
        prefix: "CCASSM",
        argOptional: true,
        openWithoutArg: true,
        argOnlySelects: true,
        argPlaceholder: "big | deposits | conc | sb | B01955",
      },
      createInstance: (context, options) => {
        const open = context.layout.instances.filter((instance) => instance.paneId === CCASS_MARKET_PANE_ID);
        const pane = open.find((instance) => instance.instanceId === context.focusedPaneId) ?? open[0];
        const arg = options?.arg?.trim() ?? "";
        const upper = arg.toUpperCase();
        const params = /^[A-Z]\d{4,6}$/.test(upper) || upper.startsWith("CIP:")
          ? commandTabParams("broker", { partId: upper })
          : upper === "DEPOSITS" || upper === "DEP"
            ? commandTabParams("deposits")
            : upper === "CONC" || upper === "CONCENTRATION"
              ? commandTabParams("concentration")
              : upper === "SB" || upper === "SOUTHBOUND"
                ? commandTabParams("southbound")
                : commandTabParams("changes");
        return {
          instanceId: pane?.instanceId ?? CCASS_MARKET_PANE_ID,
          title: "HK CCASS",
          params,
        };
      },
    },
  ],
};
