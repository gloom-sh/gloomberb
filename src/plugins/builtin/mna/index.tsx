import type { PluginModule } from "../plugin-module";
import { mnaDealCache, mnaDealsCache } from "./client";
import { DISTRESS_CACHES } from "./distress/client";
import { distressHeadless } from "./distress/headless";
import { mnaHeadless } from "./headless";
import { MNA_PANE_ID } from "./model";
import { MnaPane, MnaTickerTab } from "./pane";

export const mnaModule: PluginModule = {
  setup(ctx) {
    mnaDealsCache.attach(ctx.persistence);
    mnaDealCache.attach(ctx.persistence);
    for (const cache of DISTRESS_CACHES) cache.attach(ctx.persistence);
    ctx.registerTickerResearchTab({
      id: "mna",
      name: "M&A",
      order: 36,
      component: MnaTickerTab,
      instruments: ["equity"],
    });
  },

  dispose() {
    mnaDealsCache.reset();
    mnaDealCache.reset();
    for (const cache of DISTRESS_CACHES) cache.reset();
  },

  panes: [
    {
      id: MNA_PANE_ID,
      name: "M&A",
      icon: "M",
      component: MnaPane,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 120, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: "mna-pane",
      paneId: MNA_PANE_ID,
      label: "M&A",
      description: "Pending, rumored and closed mergers and acquisitions, with live arbitrage spreads on listed targets.",
      keywords: ["m&a", "mna", "merger", "mergers", "acquisition", "acquisitions", "takeover", "tender offer", "deal", "arbitrage", "spread"],
      shortcut: { prefix: "MA", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
      headless: mnaHeadless,
      createInstance: (_context, options) => {
        const symbol = (options?.symbol ?? options?.arg)?.trim().toUpperCase();
        return symbol
          ? { instanceId: `${MNA_PANE_ID}:${symbol}`, title: `M&A ${symbol}`, binding: { kind: "fixed" as const, symbol }, placement: "floating", settings: { ticker: symbol } }
          : { placement: "floating" };
      },
    },
    {
      // The M&A pane on its Distress tab, not a pane of its own.
      id: "distress-pane",
      paneId: MNA_PANE_ID,
      label: "Distress",
      description: "Dated public records about companies in difficulty: US 8-K bankruptcy, obligation and listing filings, SEC going-concern disclosures, Taiwan listing designations, and French and UK insolvency notices.",
      keywords: ["distress", "distressed", "bankruptcy", "chapter 11", "receivership", "going concern", "substantial doubt", "insolvency", "liquidation", "administration", "delisting", "delisted", "suspended", "special situations"],
      shortcut: { prefix: "DIST" },
      headless: distressHeadless,
      createInstance: () => ({ placement: "floating", params: { tab: "distress" } }),
    },
  ],
};
