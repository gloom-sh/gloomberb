/**
 * Plugin repositories are renaming from `gloomberb-` to `gloom-`, one at a
 * time, as the product name moves.
 *
 * A plugin is installed into a directory named after the repository it was
 * cloned from, so the same plugin can sit under either name depending on when
 * it was installed. Anything that looks a plugin up by name has to accept both,
 * or it will miss an install that is already there: the peer linker would fail
 * to resolve a sibling's imports, and the seeder would install a second copy
 * whose duplicate id the loader then refuses.
 */
export const PLUGIN_NAME_PREFIXES = ["gloom-", "gloomberb-"] as const;

/** True for a name that belongs to a plugin package under either product name. */
export function isPluginPackageName(name: string): boolean {
  return PLUGIN_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The directory names a plugin could be installed under, the given name first.
 *
 * A name with neither prefix is returned alone, so this is safe to call on any
 * dependency name.
 */
export function pluginDirectoryNames(name: string): string[] {
  for (const prefix of PLUGIN_NAME_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    const other = PLUGIN_NAME_PREFIXES.find((candidate) => candidate !== prefix);
    return [name, `${other}${name.slice(prefix.length)}`];
  }
  return [name];
}
