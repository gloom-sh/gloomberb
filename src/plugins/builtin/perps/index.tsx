import type { PluginModule } from "../plugin-module";
import { perpsCache, perpsHistoryCache, perpsMarketCache, perpsRankingsCache } from "./client";
import { perpsHeadless } from "./headless";
import { PerpsPane } from "./pane";
export const perpsModule: PluginModule = {
  panes: [{ id: "perps", name: "Perpetuals", icon: "P", component: PerpsPane, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 138, height: 34 }, tableExport: true, headless: perpsHeadless }],
  paneTemplates: [{ id: "perps-pane", paneId: "perps", label: "Perpetuals", description: "Perpetual funding, open interest and premiums by market and venue, with rankings, a venue comparison and Pro history.",
    keywords: ["perp", "perpetual", "perpetuals", "funding", "funding rate", "open interest", "hip-3", "stock perps", "basis", "venue", "funding spread", "long short ratio", "long/short", "positioning"],
    shortcut: { prefix: "PERP", argKind: "text", argOptional: true, argPlaceholder: "market" }, headless: perpsHeadless,
    createInstance: (_ctx, options) => ({ placement: "floating", settings: { market: options?.arg?.trim() ?? "" } }) }],
  setup(ctx) { perpsCache.attach(ctx.persistence); perpsHistoryCache.attach(ctx.persistence); perpsMarketCache.attach(ctx.persistence); perpsRankingsCache.attach(ctx.persistence); },
  dispose() { perpsCache.reset(); perpsHistoryCache.reset(); perpsMarketCache.reset(); perpsRankingsCache.reset(); },
};
