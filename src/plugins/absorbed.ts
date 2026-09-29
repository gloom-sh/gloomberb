import { pluginDirectoryNames } from "./plugin-names";

/**
 * Plugins that moved out into their own repositories and are built into
 * Gloomberb again, under the same id.
 *
 * Anyone who used one while it was external still has its checkout in the
 * plugins folder. Loading it beside the built-in fails on the duplicate id,
 * so the loader, the installer and the updaters leave these checkouts alone.
 * The folder itself stays: an older Gloomberb sharing the data directory may
 * still load it.
 */
export const ABSORBED_PLUGINS = [
  { id: "market-heatmap", name: "Market Heatmap", repo: "gloom-sh/gloom-market-heatmap", directory: "gloom-market-heatmap" },
  { id: "market-halts", name: "Market Halts", repo: "gloom-sh/gloom-market-halts", directory: "gloom-market-halts" },
  { id: "fear-greed", name: "Fear & Greed", repo: "gloom-sh/gloom-fear-greed", directory: "gloom-fear-greed" },
] as const;

export type AbsorbedPlugin = (typeof ABSORBED_PLUGINS)[number];

/**
 * The built-in a plugin folder or gloom.json id belongs to now, or null. A
 * folder matches under either product name, since installs made before the
 * repositories were renamed sit under the old one.
 */
export function findAbsorbedPlugin(checkout: { directory?: string | null; id?: string | null }): AbsorbedPlugin | null {
  const directory = checkout.directory?.toLowerCase();
  return ABSORBED_PLUGINS.find((plugin) => (
    plugin.id === checkout.id
    || (!!directory && pluginDirectoryNames(plugin.directory).includes(directory))
  )) ?? null;
}
