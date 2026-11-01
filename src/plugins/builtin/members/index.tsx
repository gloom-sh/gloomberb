import type { GloomPlugin } from "../../../types/plugin";
import { fundBreadthCache, fundChangesCache, fundListCache, fundMembersCache } from "./client";
import { membersHeadless } from "./headless";
import { membersTitle, TABS } from "./model";
export const membersPlugin: GloomPlugin = {
  id: "members", name: "Index and ETF members", version: "1.0.0", description: "ETF holdings, member returns, contributions, breadth and index changes", toggleable: true,
  setup(ctx) { fundBreadthCache.attach(ctx.persistence); fundListCache.attach(ctx.persistence); fundMembersCache.attach(ctx.persistence); fundChangesCache.attach(ctx.persistence); },
  dispose() { fundBreadthCache.reset(); fundListCache.reset(); fundMembersCache.reset(); fundChangesCache.reset(); },
  panes: [{ id: "members", name: "Index and ETF members", icon: "M", get component(): typeof import("./pane").MembersPane { const { MembersPane } = require("./pane"); return MembersPane; }, tickerFollower: true,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 132, height: 32 }, tableExport: true,
    settings: { fields: [{ key: "tab", label: "View", type: "select", options: TABS }] } }],
  paneTemplates: [{ id: "members-pane", paneId: "members", label: "Index and ETF members", description: "ETF holdings, member returns, daily contributions, breadth and index changes.",
    keywords: ["members", "index", "ETF", "holdings", "weights", "rebalance", "breadth", "advancers", "decliners", "MRR", "IMOV"],
    shortcut: { prefix: "MEMB", argKind: "text", argPlaceholder: "fund", argOptional: true, openWithoutArg: true }, headless: membersHeadless,
    createInstance: (_context, options) => { const symbol = (options?.arg ?? options?.symbol)?.trim().toUpperCase();
      return { placement: "floating", title: membersTitle(symbol ?? ""),
        ...(symbol ? { binding: { kind: "fixed", symbol } } : {}), settings: { tab: options?.values?.tab ?? "members" } }; },
  }],
};
