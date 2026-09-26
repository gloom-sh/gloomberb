import type { GloomPlugin } from "../types/plugin";
import { tickerResearchPluginMeta } from "./builtin/builtin-plugin-meta";
import { composeBuiltinPlugin } from "./builtin/plugin-module";
import { getLoadablePlugins } from "./catalog";
import { loadExternalPlugins, type LoadedExternalPlugin } from "./loader";

const tickerResearchBackendPlugin = composeBuiltinPlugin({ ...tickerResearchPluginMeta, modules: [] });

export function getDesktopBackendPlugins(
  externalPlugins: LoadedExternalPlugin[] = [],
): GloomPlugin[] {
  return getLoadablePlugins(externalPlugins).map((plugin) => {
    if (plugin.id === "ticker-research") return tickerResearchBackendPlugin;
    return plugin;
  });
}

export interface DesktopBackendPlugins {
  plugins: GloomPlugin[];
  /**
   * The external entries behind `plugins`, handed to the runtime so a plugin
   * that fails to register is marked failed rather than failing the launch.
   */
  externalPlugins: LoadedExternalPlugin[];
}

export async function loadDesktopBackendPlugins(): Promise<DesktopBackendPlugins> {
  const externalPlugins = await loadExternalPlugins("desktop");
  return { plugins: getDesktopBackendPlugins(externalPlugins), externalPlugins };
}
