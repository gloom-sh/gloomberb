import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { debtMaturitiesCache } from "./client";
import { debtMaturitiesHeadless } from "./headless";
import { DebtMaturitiesPane } from "./pane";

export const debtMaturitiesModule: PluginModule = {
  panes: [
    {
      id: "debt-maturities",
      name: "Debt Maturities",
      icon: "D",
      component: DebtMaturitiesPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 96, height: 30 },
      tableExport: true,
      headless: debtMaturitiesHeadless,
    },
  ],
  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "debt-maturities-pane",
        paneId: "debt-maturities",
        label: "Debt Maturities",
        description:
          "Principal maturity wall, concentration and dated annual filing history.",
        shortcut: "DDIS",
        keywords: ["debt", "maturity", "maturities", "refinancing", "ddis"],
        publicShare: true,
      }),
      headless: debtMaturitiesHeadless,
    },
  ],
  setup(ctx) {
    debtMaturitiesCache.attach(ctx.persistence);
  },
  dispose() {
    debtMaturitiesCache.reset();
  },
};
