import type { GloomPlugin } from "../types/plugin";
import { tickerResearchBackendPlugin } from "./builtin/ticker-research-backend-plugin";
import { getLoadablePlugins } from "./catalog";
import { loadExternalPlugins, type LoadedExternalPlugin } from "./loader";
import { predictionMarketsBackendPlugin } from "./prediction-markets/backend-plugin";

export function getDesktopBackendPlugins(
  externalPlugins: LoadedExternalPlugin[] = [],
): GloomPlugin[] {
  return getLoadablePlugins(externalPlugins).map((plugin) => {
    if (plugin.id === "ticker-research") return tickerResearchBackendPlugin;
    if (plugin.id === "prediction-markets") return predictionMarketsBackendPlugin;
    return plugin;
  });
}

export async function loadDesktopBackendPlugins(): Promise<GloomPlugin[]> {
  return getDesktopBackendPlugins(await loadExternalPlugins("desktop"));
}
