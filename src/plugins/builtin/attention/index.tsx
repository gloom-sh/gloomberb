import type { PluginModule } from "../plugin-module";
import { attentionCache } from "./client";
import { attentionWindow } from "./model";
import { attentionHeadless } from "./headless";
import { ATTENTION_SERIES } from "./series";
import { ATTENTION_LISTED } from "./listing";
export const attentionModule: PluginModule = {
  panes: [{ id: "attention", name: "Research Attention", icon: "A", get component(): typeof import("./pane").AttentionPane { const { AttentionPane } = require("./pane"); return AttentionPane; }, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 126, height: 32 }, tableExport: true, headless: attentionHeadless },
    { id: "attention-trending", reportFreshness: { status: "not-a-feed", basis: "hourly publication" }, name: "Gloom Trending", icon: "A", get component(): typeof import("./trending").TrendingPane { const { TrendingPane } = require("./trending"); return TrendingPane; }, defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 58, height: 12 } }],
  paneTemplates: [{ id: "attention-pane", paneId: "attention", label: "Research Attention", listed: ATTENTION_LISTED,
    description: "Pro research attention: rankings, abnormal activity, sectors, countries and privacy-qualified hourly history.",
    keywords: ["attention", "trending", "research", "activity"], shortcut: { prefix: "ATTN", argKind: "text", argPlaceholder: "TICKER", argOptional: true },
    headless: attentionHeadless, createInstance: (_ctx, options) => ({ placement: "floating", settings: { window: attentionWindow(options?.values?.window), symbol: (options?.arg ?? options?.symbol)?.trim().toUpperCase() ?? "" } }) },
    { id: "attention-trending-pane", paneId: "attention-trending", label: "Gloom Trending", description: "Compact daily research attention for a home workspace.", keywords: ["trending", "home"], createInstance: () => ({ placement: "floating" }) }],
  series: ATTENTION_SERIES,
  setup(ctx) { attentionCache.attach(ctx.persistence); },
  dispose() { attentionCache.reset(); },
};
