import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { graphCache } from "./graph-client";
import { supplyChainCache } from "./client";
import { supplyChainHeadless } from "./headless";
import { SupplyChainPane } from "./pane";

/** What another pane can open SPLC on: a Graph or Path view, its target and its query, as `graphOptions` reads them. */
const OPENING_SETTINGS = ["tab", "to", "depth", "direction", "roles", "tiers"];
const openingSettings = (values: Record<string, string> = {}) =>
  Object.fromEntries(OPENING_SETTINGS.flatMap((key) => values[key] ? [[key, values[key]]] : []));

export const supplyChainModule: PluginModule = {
  setup(ctx) { supplyChainCache.attach(ctx.persistence); graphCache.attach(ctx.persistence); },
  dispose() { supplyChainCache.reset(); graphCache.reset(); },
  panes: [{ id: "supply-chain", name: "Supply Chain", icon: "S", component: SupplyChainPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 130, height: 30 },
    tickerFollower: true, tableExport: true, headless: supplyChainHeadless }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({ id: "supply-chain-pane", paneId: "supply-chain", label: "Supply Chain",
    description: "Pro global supply chain evidence from filings, company announcements, calls and news, with trust tiers, original quotes, native units, four-hop graphs, ranked paths and a free preview.",
    keywords: ["supply", "supply chain", "suppliers", "customers", "concentration", "filings", "earnings calls", "news", "evidence", "global", "Korea", "Japan", "Taiwan", "graph", "paths", "Pro"], shortcut: "SPLC", shortcutAliases: ["SUPPLY"],
    settings: (_symbol, _context, options) => openingSettings(options?.values),
    // A route opened from another pane gets a pane of its own, so the company's SPLC keeps its view.
    viewKey: (_symbol, _context, options) => options?.values?.to ? `${options.values.tab ?? "graph"}:${options.values.to}` : undefined,
  }), headless: supplyChainHeadless }],
};
