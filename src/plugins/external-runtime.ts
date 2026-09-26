import type { LoadedExternalPlugin } from "./loader";

/**
 * The external plugins this process knows about, as a list that can change
 * after startup.
 *
 * Startup hands the app a frozen array of what was in the plugins folder. An
 * install, update, or removal from the marketplace has to be reflected in the
 * same list, otherwise the pane keeps describing the folder as it was when
 * the app launched. This is that list, with the startup array as its seed.
 */

let entries: LoadedExternalPlugin[] = [];
let seeded: readonly LoadedExternalPlugin[] | null = null;

/** Adopts the startup list once; later calls with the same array are no-ops. */
export function seedExternalPlugins(initial: readonly LoadedExternalPlugin[] | undefined): void {
  if (!initial || seeded === initial) return;
  seeded = initial;
  entries = [...initial];
}

export function listExternalPlugins(): readonly LoadedExternalPlugin[] {
  return entries;
}

/** Replaces the entry for the same plugin id or directory, or appends. */
export function upsertExternalPlugin(entry: LoadedExternalPlugin): void {
  const index = entries.findIndex((existing) => (
    existing.plugin.id === entry.plugin.id
    || (!!entry.directory && existing.directory === entry.directory)
    || existing.path === entry.path
  ));
  if (index >= 0) entries = [...entries.slice(0, index), entry, ...entries.slice(index + 1)];
  else entries = [...entries, entry];
}

/**
 * Drops the entry for a plugin id, or for a folder: a plugin that failed to
 * import only has its folder to be addressed by, and the id the marketplace
 * knows it under is the registry's.
 */
export function removeExternalPlugin(pluginId: string, directory?: string): void {
  const next = entries.filter((entry) => (
    entry.plugin.id !== pluginId && (!directory || entry.directory !== directory)
  ));
  if (next.length === entries.length) return;
  entries = next;
}
