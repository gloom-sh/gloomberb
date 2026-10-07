import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { reverseDcfHeadless } from "./headless";
import { DISCOUNT_OPTIONS, ReverseDcfPane } from "./pane";

export const reverseDcfModule: PluginModule = {
  panes: [{
    id: "reverse-dcf", name: "Reverse DCF", icon: "R", component: ReverseDcfPane,
    defaultPosition: "right", tickerFollower: true, defaultMode: "floating", defaultFloatingSize: { width: 80, height: 20 },
    tableExport: true,
    settings: { title: "Reverse DCF Settings", fields: [
      { key: "discountRate", label: "Discount rate", type: "select", options: DISCOUNT_OPTIONS },
    ] },
  }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({
    id: "reverse-dcf-pane", paneId: "reverse-dcf", label: "Reverse DCF",
    description: "The free cash flow growth the current enterprise value prices in, next to the growth the company delivered.",
    keywords: ["rdcf", "reverse dcf", "dcf", "implied growth", "valuation", "intrinsic value"], shortcut: "RDCF", publicShare: true,
  }), headless: reverseDcfHeadless }],
};
