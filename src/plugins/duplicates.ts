import type { GloomPlugin } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { compareSemver } from "../utils/semver";
import type { LoadedExternalPlugin } from "./loader";

const duplicatesLog = debugLog.createLogger("plugin-loader");

function copyName(entry: LoadedExternalPlugin): string {
  return entry.directory ?? entry.path;
}

/** Whether the host would register the entry, which is when its id can collide with another's. */
function registers(entry: LoadedExternalPlugin): boolean {
  return !entry.error && !entry.unsupportedTarget && !entry.needsRestart;
}

/**
 * Negative when `a` is the copy to keep: a linked checkout over a copy, then
 * the higher version, then the folder name that sorts first.
 */
function compareCopies(a: LoadedExternalPlugin, b: LoadedExternalPlugin): number {
  if (!!a.linked !== !!b.linked) return a.linked ? -1 : 1;
  const byVersion = compareSemver(b.plugin.version, a.plugin.version);
  if (byVersion) return byVersion;
  const left = copyName(a);
  const right = copyName(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Keeps one folder of each plugin id that more than one loaded plugin
 * declares. A second copy (a download beside a marketplace install, a dev
 * link beside a clone) would otherwise fail to register on the id the first
 * took, on every launch. The others come back with `duplicateOf` and an
 * `error` naming the folder that loads instead, so nothing registers them,
 * and the Plugins pane lists them. Only plugins that loaded compete, so a
 * copy that failed to import never hides one that works. Folders are left as
 * they are.
 */
export function skipDuplicatePluginIds(entries: LoadedExternalPlugin[]): LoadedExternalPlugin[] {
  const kept = new Map<string, LoadedExternalPlugin>();
  for (const entry of entries) {
    if (!registers(entry)) continue;
    const current = kept.get(entry.plugin.id);
    if (!current || compareCopies(entry, current) < 0) kept.set(entry.plugin.id, entry);
  }
  return entries.map((entry) => {
    const winner = registers(entry) ? kept.get(entry.plugin.id) : undefined;
    if (!winner || winner === entry) return entry;
    const loadsInstead = copyName(winner);
    duplicatesLog.info(`Skipped ${copyName(entry)}: ${entry.plugin.id} loads from ${loadsInstead} instead`);
    return {
      ...entry,
      // Named after its folder, as a plugin that failed to import is: two rows of one name would not say which is which.
      plugin: { id: copyName(entry), name: copyName(entry), version: entry.plugin.version ?? "" } as GloomPlugin,
      error: `The ${loadsInstead} folder has the same plugin id (${entry.plugin.id}) and loads instead.`,
      duplicateOf: loadsInstead,
    };
  });
}
