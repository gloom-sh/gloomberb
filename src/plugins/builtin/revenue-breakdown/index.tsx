import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { isKnownNonUsListing } from "../../../utils/sec";
import { revenueBreakdownCache } from "./client";
import { revenueBreakdownHeadless } from "./headless";
import {
  REVENUE_BREAKDOWN_PANE_ID,
  RevenueBreakdownPane,
  RevenueResearchTab,
} from "./pane";

export const revenueBreakdownModule: PluginModule = {
  setup(ctx) {
    revenueBreakdownCache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "revenue",
      name: "Revenue",
      order: 22,
      component: RevenueResearchTab,
      instruments: ["equity"],
      isVisible: ({ ticker }) => !isKnownNonUsListing(ticker),
    });
  },

  dispose() {
    revenueBreakdownCache.reset();
  },

  panes: [
    {
      id: REVENUE_BREAKDOWN_PANE_ID,
      name: "Revenue Breakdown",
      icon: "R",
      component: RevenueBreakdownPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 16 },
      tableExport: true,
      headless: revenueBreakdownHeadless,
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "revenue-breakdown-seg",
        paneId: REVENUE_BREAKDOWN_PANE_ID,
        label: "Revenue Breakdown",
        description:
          "Quarterly revenue by product, segment or region from the company's 10-Q and 10-K filings.",
        shortcut: "SEG",
        keywords: ["revenue", "segments", "segment", "products", "product", "geography", "regions", "seg"],
        settings: () => ({ view: "product" }),
      }),
      headless: revenueBreakdownHeadless,
    },
  ],
};
