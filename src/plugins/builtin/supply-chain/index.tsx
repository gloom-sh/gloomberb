import type { PluginModule } from "../plugin-module";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { graphCache } from "./graph-client";
import { supplyChainCache } from "./client";
import { supplyChainHeadless } from "./headless";
import { SupplyChainPane } from "./pane";

export const supplyChainModule: PluginModule = {
  setup(ctx) { supplyChainCache.attach(ctx.persistence); graphCache.attach(ctx.persistence); },
  dispose() { supplyChainCache.reset(); graphCache.reset(); },
  panes: [{ id: "supply-chain", name: "Supply Chain", icon: "S", component: SupplyChainPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 130, height: 30 },
    tickerFollower: true, tableExport: true, headless: supplyChainHeadless }],
  paneTemplates: [{ ...createTickerSurfacePaneTemplate({ id: "supply-chain-pane", paneId: "supply-chain", label: "Supply Chain",
    description: "Pro global supply chain evidence from filings, company announcements, calls and news, with trust tiers, original quotes, native units, four-hop graphs, ranked paths and a free preview.",
    keywords: ["supply", "supply chain", "suppliers", "customers", "concentration", "filings", "earnings calls", "news", "evidence", "global", "Korea", "Japan", "Taiwan", "graph", "paths", "Pro"], shortcut: "SPLC", shortcutAliases: ["SUPPLY"] }), headless: supplyChainHeadless }],
};
