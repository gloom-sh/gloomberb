import type { PaneTemplateInstanceConfig } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { commandRequestParams } from "../shared/command-tab";
import { PERP_SERIES } from "./series";
import { perpsCache, perpsDepthCache, perpsHistoryCache, perpsLiquidationsCache, perpsListCache, perpsMarketCache, perpsRankingsCache } from "./client";
import { perpsHeadless } from "./headless";

/**
 * A named market has its own pane, and asking for it again (PERP, a stock's perpetual row in DES or QQ) brings that
 * pane back to the market's history, whatever it was showing: the request is stamped onto the instance, so the pane
 * sees it even when nothing else about the instance changed. Without a market, the board.
 */
export function perpsInstance(arg: string | undefined): PaneTemplateInstanceConfig {
  const market = arg?.trim() ?? "";
  if (!market) return { placement: "floating", settings: { market } };
  return { instanceId: `perps:${encodeURIComponent(market.toUpperCase()).replace(/%/g, "~")}`, placement: "floating",
    settings: { market }, params: commandRequestParams({ market }) };
}

const PERP_CACHES = [perpsCache, perpsHistoryCache, perpsListCache, perpsMarketCache, perpsRankingsCache, perpsLiquidationsCache, perpsDepthCache] as const;

export const perpsModule: PluginModule = {
  series: PERP_SERIES,
  panes: [{ id: "perps", name: "Perpetuals", icon: "P", get component(): typeof import("./pane").PerpsPane { const { PerpsPane } = require("./pane"); return PerpsPane; }, defaultPosition: "right", defaultMode: "floating",
    defaultFloatingSize: { width: 138, height: 34 }, tableExport: true, headless: perpsHeadless }],
  paneTemplates: [{ id: "perps-pane", paneId: "perps", label: "Perpetuals", description: "Perpetual funding, open interest and premiums by market and venue, with rankings, a venue comparison, liquidations, order book depth and Pro history.",
    keywords: ["perp", "perpetual", "perpetuals", "funding", "funding rate", "open interest", "hip-3", "stock perps", "basis", "basis trade", "carry", "venue", "funding spread", "long short ratio", "long/short", "positioning", "liquidations", "liquidation", "order book depth", "market depth", "liquidity"],
    shortcut: { prefix: "PERP", argKind: "text", argOptional: true, argPlaceholder: "market" }, headless: perpsHeadless,
    createInstance: (_ctx, options) => perpsInstance(options?.arg) }],
  setup(ctx) {
    for (const cache of PERP_CACHES) cache.attach(ctx.persistence);
  },
  dispose() { for (const cache of PERP_CACHES) cache.reset(); },
};
