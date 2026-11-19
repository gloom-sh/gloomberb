import { logFailure } from "../utils/log-failure";
import { SeriesRegistry } from "./registry";
import { type SeriesPlugins, pluginsOf } from "./standalone";
import type { SeriesCatalogEntry } from "./types";

let standaloneEntries: (() => readonly SeriesCatalogEntry[]) | null = null;

/**
 * The catalog a chart reads a series' id or name from (`fn G fut:crack-321`)
 * where no plugin runtime runs: the series the plugins declare, registered
 * once on first read. Null forgets it.
 */
export function setStandaloneSeriesCatalog(plugins: SeriesPlugins | null, disabledPlugins: readonly string[] = []): void {
  if (!plugins) {
    standaloneEntries = null;
    return;
  }
  let entries: readonly SeriesCatalogEntry[] | null = null;
  standaloneEntries = () => {
    if (entries) return entries;
    const all = pluginsOf(plugins);
    const registry = new SeriesRegistry({ pluginHosts: (pluginId) => all.find((plugin) => plugin.id === pluginId)?.hosts });
    for (const plugin of all) {
      if (disabledPlugins.includes(plugin.id)) continue;
      for (const definition of plugin.series ?? []) {
        try {
          registry.register(plugin.id, definition);
        } catch (error) {
          logFailure("series.standalone", "Registering a standalone catalog series failed")(error);
        }
      }
    }
    entries = registry.catalog();
    return entries;
  };
}

/** The plugins' declared catalog where no plugin runtime runs (`setStandaloneSeriesCatalog`); empty where none was set. */
export function standaloneSeriesCatalogEntries(): readonly SeriesCatalogEntry[] {
  return standaloneEntries?.() ?? [];
}
