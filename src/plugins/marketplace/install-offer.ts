import { findAbsorbedPlugin } from "../absorbed";
import type { RegistryPlugin, RegistryPluginShortcut } from "./model";

/**
 * Which registry plugins a typed code may lead to installing, read by the
 * command bar's install row and by the command line's answer to a code it
 * does not know.
 */

/**
 * A repository Gloom publishes, as `owner/name` and nothing else: the command
 * line prints `gloom install <repo>` for it, so a feed entry cannot make that
 * line say more than one plain word.
 */
const OFFERED_REPO = /^gloom-sh\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Only plugins Gloom publishes. A typed word must never lead to installing
 * someone else's code, so the repository owner decides, not the feed's tier.
 * A plugin that is built in now (absorbed.ts) is never offered, whatever the
 * feed says: its code opens the built-in, and the installer refuses it.
 */
function isOfferablePlugin(plugin: RegistryPlugin): boolean {
  return plugin.tier === "official"
    && plugin.bundled !== true
    && typeof plugin.repo === "string" && OFFERED_REPO.test(plugin.repo)
    && !findAbsorbedPlugin({ id: plugin.id });
}

/** The feed is read defensively: an entry can come from any registry version. */
function declaredShortcuts(plugin: RegistryPlugin): RegistryPluginShortcut[] {
  const shortcuts = plugin.contributes?.shortcuts;
  if (!Array.isArray(shortcuts)) return [];
  return shortcuts.filter((shortcut): shortcut is RegistryPluginShortcut => (
    !!shortcut && typeof shortcut.code === "string" && typeof shortcut.name === "string"
  ));
}

/** The offerable plugin that declares `code` (any case), with its shortcut, or null. */
export function findOfferedShortcut(
  registry: readonly RegistryPlugin[],
  code: string,
): { plugin: RegistryPlugin; shortcut: RegistryPluginShortcut } | null {
  const wanted = code.trim().toUpperCase();
  if (!wanted) return null;
  for (const plugin of registry) {
    if (!isOfferablePlugin(plugin)) continue;
    const shortcut = declaredShortcuts(plugin).find((entry) => entry.code.trim().toUpperCase() === wanted);
    if (shortcut) return { plugin, shortcut };
  }
  return null;
}

/** Installed means loaded, listed under its id, or checked out under its repository's folder. */
export function isRegistryPluginInstalled(
  plugin: RegistryPlugin,
  installed: ReadonlyArray<{ id: string; directory?: string }>,
): boolean {
  const directory = plugin.repo?.split("/")[1]?.replace(/\.git$/, "").toLowerCase();
  return installed.some((entry) => (
    entry.id === plugin.id
    || (!!directory && entry.directory?.toLowerCase() === directory)
  ));
}
