import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { holdersHeadless } from "./headless";
import { HoldersView } from "./pane";

export { holdersHeadless } from "./headless";

export const holdersModule: PluginModule = {
  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "holders",
      name: "Holders",
      order: 42,
      component: HoldersView,
      isVisible: ({ ticker }) => !!ticker,
    });
  },

  panes: [
    {
      id: "holders",
      name: "Holders",
      icon: "H",
      component: HoldersView,
      defaultPosition: "right",
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
        description: "Institutional holders for the selected ticker.",
        keywords: ["holders", "ownership", "institutional", "owners", "hds"],
        shortcut: "HDS",
      }),
      headless: holdersHeadless,
    },
  ],
};
