import type { GloomPlugin, PluginTarget } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { debugPlugin } from "./builtin/debug";
import { yahooPlugin } from "./builtin/yahoo";
import { uiBuiltinPlugins } from "./catalog-ui";

export interface PluginCatalogEntry {
  plugin: GloomPlugin;
  source: "builtin" | "external";
  path?: string;
  error?: string;
  /**
   * Set when the plugin installed cleanly but cannot run here — IBKR Gateway on
   * the web build, for example. The catalog still lists it so the marketplace
   * can explain why it is inert instead of leaving the user wondering.
   */
  unsupportedTarget?: PluginTarget;
}

const builtinPlugins: GloomPlugin[] = [
  yahooPlugin,
  ...uiBuiltinPlugins,
  debugPlugin,
];

export function getPluginCatalog(externalPlugins: LoadedExternalPlugin[] = []): PluginCatalogEntry[] {
  return [
    ...builtinPlugins.map((plugin) => ({
      plugin,
      source: "builtin" as const,
    })),
    ...externalPlugins.map((entry) => ({
      plugin: entry.plugin,
      source: "external" as const,
      path: entry.path,
      error: entry.error,
      unsupportedTarget: entry.unsupportedTarget,
    })),
  ];
}

export function getLoadablePlugins(externalPlugins: LoadedExternalPlugin[] = []): GloomPlugin[] {
  return getPluginCatalog(externalPlugins)
    .filter((entry) => !entry.error && !entry.unsupportedTarget)
    .map((entry) => entry.plugin);
}
