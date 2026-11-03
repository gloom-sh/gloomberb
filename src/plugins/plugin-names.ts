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
const PLUGIN_NAME_PREFIXES = ["gloom-", "gloomberb-"] as const;

/**
 * A plugin package name is one folder name: a prefix, then letters, digits,
 * dots, dashes and underscores. A name read from a plugin's manifest is
 * joined to the plugins folder, so a slash or a backslash would reach past it.
 */
const PLUGIN_PACKAGE_NAME = /^(?:gloom|gloomberb)-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True for a name that belongs to a plugin package under either product name. */
export function isPluginPackageName(name: string): boolean {
  return PLUGIN_PACKAGE_NAME.test(name);
}

/**
 * The directory names a plugin could be installed under, the given name first.
 *
 * A name with neither prefix is returned alone, so this is safe to call on any
 * dependency name. A name with a prefix that is not a plugin package name has
 * no folder to look in.
 */
export function pluginDirectoryNames(name: string): string[] {
  for (const prefix of PLUGIN_NAME_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    if (!isPluginPackageName(name)) return [];
    const other = PLUGIN_NAME_PREFIXES.find((candidate) => candidate !== prefix);
    return [name, `${other}${name.slice(prefix.length)}`];
  }
  return [name];
}
