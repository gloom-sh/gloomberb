import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { reverseDcfHeadless } from "./headless";
import { DISCOUNT_OPTIONS, MARGIN_OPTIONS, ReverseDcfPane } from "./pane";

export const reverseDcfModule: PluginModule = {
  panes: [{
    id: "reverse-dcf", name: "Reverse DCF", icon: "R", component: ReverseDcfPane,
    defaultPosition: "right", tickerFollower: true, instruments: ["equity"], defaultMode: "floating", defaultFloatingSize: { width: 80, height: 20 },
    tableExport: true,
    // Dated as `fn RDCF` dates it, by the regular close the enterprise value is measured at, not by the quote's latest print.
    reportFreshness: reverseDcfHeadless.freshness,
    settings: { title: "Reverse DCF Settings", fields: [
      { key: "discountRate", label: "Discount rate", type: "select", options: DISCOUNT_OPTIONS },
      { key: "margin", label: "FCF margin", description: "The free cash flow margin the implied year-10 revenue assumes.", type: "select", options: MARGIN_OPTIONS },
    ] },
  }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({
    id: "reverse-dcf-pane", paneId: "reverse-dcf", label: "Reverse DCF",
    description: "The free cash flow growth the current enterprise value prices in, next to the growth the company delivered.",
    keywords: ["rdcf", "reverse dcf", "dcf", "implied growth", "valuation", "intrinsic value"], shortcut: "RDCF", publicShare: true,
  }), headless: reverseDcfHeadless }],
};
