import type { GloomPlugin } from "../types/plugin";
import { tickerResearchBackendPlugin } from "./builtin/ticker-research-backend-plugin";
import { getLoadablePlugins } from "./catalog";
import { predictionMarketsBackendPlugin } from "./prediction-markets/backend-plugin";

export function getDesktopBackendPlugins(): GloomPlugin[] {
  return getLoadablePlugins().map((plugin) => {
    if (plugin.id === "ticker-research") return tickerResearchBackendPlugin;
    if (plugin.id === "prediction-markets") return predictionMarketsBackendPlugin;
    return plugin;
  });
}
