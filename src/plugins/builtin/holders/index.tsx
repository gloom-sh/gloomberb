import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { beneficialOwnersCache } from "./beneficial-client";
import { holdersHeadless } from "./headless";
import { HoldersView } from "./pane";

export const holdersModule: PluginModule = {
  setup(ctx) {
    beneficialOwnersCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "holders",
      name: "Holders",
      order: 42,
      component: HoldersView,
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
      component: HoldersView,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 105, height: 34 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "holders-pane",
        paneId: "holders",
        label: "Holders",
        description: "Institutional holders from 13F filings, and 13D/13G beneficial owners: activist and passive stakes over 5% of the class.",
        keywords: [
          "holders", "ownership", "institutional", "owners", "hds",
          "13d", "13g", "13d/g", "schedule 13d", "schedule 13g", "beneficial owners", "beneficial ownership", "activist", "activists",
        ],
        shortcut: "HDS",
      }),
      headless: holdersHeadless,
    },
  ],
};
