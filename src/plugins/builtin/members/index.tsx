import type { GloomPlugin } from "../../../types/plugin";
import { fundChangesCache, fundListCache, fundMembersCache } from "./client";
import { membersHeadless } from "./headless";
import { MembersPane } from "./pane";
import { membersTitle } from "./model";
export const membersPlugin: GloomPlugin = {
  id: "members", name: "Index and ETF members", version: "1.0.0", description: "ETF holdings, member returns, contributions and index changes", toggleable: true,
  setup(ctx) { fundListCache.attach(ctx.persistence); fundMembersCache.attach(ctx.persistence); fundChangesCache.attach(ctx.persistence); },
  dispose() { fundListCache.reset(); fundMembersCache.reset(); fundChangesCache.reset(); },
  panes: [{ id: "members", name: "Index and ETF members", icon: "M", component: MembersPane, tickerFollower: true,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 132, height: 32 }, tableExport: true,
    settings: { fields: [{ key: "tab", label: "View", type: "select", options: [{ value: "members", label: "Members" }, { value: "movers", label: "Movers" }, { value: "changes", label: "Changes" }] }] } }],
  paneTemplates: [{ id: "members-pane", paneId: "members", label: "Index and ETF members", description: "ETF holdings, member returns, daily contributions and index changes.",
    keywords: ["members", "index", "ETF", "holdings", "weights", "rebalance", "MRR", "IMOV"],
    shortcut: { prefix: "MEMB", argKind: "ticker", argPlaceholder: "fund", argOptional: true, openWithoutArg: true }, headless: membersHeadless,
    createInstance: (_context, options) => { const symbol = (options?.arg ?? options?.symbol)?.trim().toUpperCase();
      return { placement: "floating", title: membersTitle(symbol ?? ""),
        ...(symbol ? { binding: { kind: "fixed", symbol } } : {}), settings: { tab: options?.values?.tab ?? "members" } }; },
  }],
};
