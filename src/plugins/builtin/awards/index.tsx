import type { PluginModule } from "../plugin-module";
import { awardDetailCache, awardsCache } from "./client";
import { awardsHeadless } from "./headless";
import { AwardsPane } from "./pane";

export const awardsModule: PluginModule = {
  setup(ctx) { awardsCache.attach(ctx.persistence); awardDetailCache.attach(ctx.persistence); },
  dispose() { awardsCache.reset(); awardDetailCache.reset(); },
  panes: [{ id: "awards", name: "Government Awards", icon: "A", component: AwardsPane, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 132, height: 34 }, tickerFollower: true, tableExport: true, headless: awardsHeadless,
    quickSettings: [{ type: "toggle", key: "awardAlerts", icon: "zap", label: "New awards above 1% of annual revenue" }],
    settings: { title: "Government awards", fields: [{ type: "toggle", key: "awardAlerts", label: "New awards above 1% of annual revenue", description: "Notify while this pane is visible. Starts with the next refresh; historical backfills are excluded." }] } }],
  paneTemplates: [{ id: "awards-pane", paneId: "awards", label: "Government Awards", description: "Pro: government awards, company history, agency concentration and revenue exposure with source evidence.",
    keywords: ["awards", "contracts", "government", "procurement", "defense", "tenders", "obligations", "pro"],
    shortcut: { prefix: "AWARDS", argKind: "text", argPlaceholder: "ticker", argOptional: true }, headless: awardsHeadless,
    createInstance: (_context, options) => {
      const symbol = (options?.symbol ?? options?.arg)?.trim().toUpperCase();
      return { placement: "floating", ...(symbol ? { title: `AWARDS ${symbol}`, binding: { kind: "fixed", symbol }, settings: { tab: "company" } } : {}) };
    } }],
};
