import type { GloomPlugin, PluginTarget } from "../types/plugin";

/**
 * What a plugin module exports and where it runs, read the same way by every
 * loader: the terminal importing from disk, the desktop's Bun side reading
 * metadata, the desktop view and the web app evaluating compiled bundles, and
 * the CLI validating an install. It imports nothing at runtime so the browser
 * renderers can use it too.
 */

/**
 * The plugin a module exports: `export default`, or a named `plugin` export.
 * Null when that is not a plugin with an id and a name.
 */
export function pluginFromModule(mod: unknown): GloomPlugin | null {
  const exports = mod as { default?: GloomPlugin; plugin?: GloomPlugin } | null | undefined;
  const plugin = exports?.default ?? exports?.plugin;
  return plugin?.id && plugin.name ? plugin : null;
}

export function pluginSupportsTarget(plugin: GloomPlugin, target: PluginTarget): boolean {
  // No declaration means "everywhere"; the registry fills this in for listed plugins.
  return !plugin.targets || plugin.targets.length === 0 || plugin.targets.includes(target);
}
