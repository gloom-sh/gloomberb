import type { FunctionAccess } from "../cli/pane-functions/function-help";
import type { GloomPlugin, PluginTarget } from "../types/plugin";
import { ABSORBED_PLUGINS } from "./absorbed";
import { highlightedCodes, pluginFunctions } from "./plugin-functions";
import { BUILTIN_EDITORIAL } from "./builtin-editorial";
import { getPluginCatalog } from "./catalog";
import { browserBuiltinPlugins } from "./catalog-browser";

/**
 * The public description of the plugins that ship inside Gloomberb.
 *
 * The plugin directory has to list built-ins alongside installable ones, but a
 * built-in has no repository to read metadata from. Hand-maintaining that half
 * elsewhere meant it silently drifted every time a built-in changed its panes
 * or description, so it is derived from the live catalog here instead and
 * checked against a committed snapshot in CI. Editorial copy the catalog does
 * not carry lives in `builtin-editorial.ts`.
 *
 * Fields added since the first version are optional for the directory, which
 * keeps reading a manifest without them.
 */

/** A function the plugin adds, as the directory lists it. */
interface BuiltinShortcutManifestEntry {
  code: string;
  name: string;
  description: string;
  /** Free gets only the upgrade (`pro`) or a preview (`preview`); absent when Free gets it all. */
  access?: FunctionAccess;
  /** Where it runs, when that is narrower than the plugin: a code the web app lacks. */
  targets?: PluginTarget[];
}

interface BuiltinPluginManifestEntry {
  id: string;
  name: string;
  description: string;
  /** Ten words at most, for a card. */
  tagline?: string;
  /** Curated, since the catalog has no notion of categories. */
  categories: string[];
  toggleable: boolean;
  featured?: true;
  /** Path to artwork in this repo, resolved by the directory against HEAD. */
  icon?: string;
  /** Everywhere the app runs, and the web when the browser catalog carries it. */
  targets: PluginTarget[];
  contributes: {
    panes: string[];
    capabilities: string[];
    broker: boolean;
    shortcuts?: BuiltinShortcutManifestEntry[];
  };
  /** The codes a card shows. */
  highlights?: string[];
  /** Codes whose reviewed capture the directory shows, best first. */
  screenshots?: string[];
}

export interface BuiltinManifest {
  version: 1;
  plugins: BuiltinPluginManifestEntry[];
  /** Built-in ids with no editorial entry; a non-empty list fails generation. */
  uncategorised: string[];
  /** Editorial highlights or screenshots naming a code the plugin lacks, as `id:CODE`; these fail generation too. */
  unknownCodes: string[];
}

const NATIVE_TARGETS: PluginTarget[] = ["cli", "tui", "desktop"];

/**
 * The codes a plugin's pane templates answer to. Commands a plugin registers
 * while it sets up (ALRT, NOTE) are not known until it runs, so they are not
 * listed; the Plugins pane reads them from the running app.
 */
function functionsOf(plugin: GloomPlugin) {
  return pluginFunctions({
    templates: (plugin.paneTemplates ?? []).map((template) => ({
      label: template.label,
      prefix: template.shortcut?.prefix,
      description: template.description,
    })),
  });
}

export function buildBuiltinManifest(): BuiltinManifest {
  const uncategorised: string[] = [];
  const unknownCodes: string[] = [];
  const web = new Map(browserBuiltinPlugins.map((plugin) => [plugin.id, plugin]));

  const plugins = getPluginCatalog()
    // Built in again, but released apps from before that still install these
    // from their repositories, and the directory drops a repository row whose
    // id a built-in claims. This build shows that row as its built-in, so they
    // join the manifest once those releases have updated.
    .filter(({ plugin }) => !ABSORBED_PLUGINS.some((absorbed) => absorbed.id === plugin.id))
    .map(({ plugin }): BuiltinPluginManifestEntry => {
      const editorial = BUILTIN_EDITORIAL[plugin.id];
      if (!editorial) uncategorised.push(plugin.id);

      // Some built-ins carry fewer functions in the web app.
      const webPlugin = web.get(plugin.id);
      const webCodes = new Set(webPlugin ? functionsOf(webPlugin).map((fn) => fn.code) : []);
      const functions = functionsOf(plugin);
      const shortcuts = functions.map((fn): BuiltinShortcutManifestEntry => ({
        ...fn,
        ...(webPlugin && !webCodes.has(fn.code) ? { targets: [...NATIVE_TARGETS] } : {}),
      }));
      const codes = new Set(functions.map((fn) => fn.code));
      for (const code of [...editorial?.highlights ?? [], ...editorial?.screenshots ?? []]) {
        if (!codes.has(code)) unknownCodes.push(`${plugin.id}:${code}`);
      }
      const screenshots = (editorial?.screenshots ?? []).filter((code) => codes.has(code));

      return {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description ?? "",
        ...(editorial?.tagline ? { tagline: editorial.tagline } : {}),
        categories: editorial?.categories ?? [],
        toggleable: plugin.toggleable === true,
        ...(editorial?.featured ? { featured: true as const } : {}),
        ...(editorial?.icon ? { icon: editorial.icon } : {}),
        targets: webPlugin ? [...NATIVE_TARGETS, "web"] : [...NATIVE_TARGETS],
        contributes: {
          panes: (plugin.panes ?? []).map((pane) => pane.id).sort(),
          capabilities: (plugin.capabilities ?? [])
            .map((capability) => {
              const value = capability as { id?: string; kind?: string };
              return value.id ?? value.kind ?? "capability";
            })
            .sort(),
          broker: !!plugin.broker,
          ...(shortcuts.length > 0 ? { shortcuts } : {}),
        },
        ...(functions.length > 0 ? { highlights: highlightedCodes(plugin.id, functions) } : {}),
        ...(screenshots.length > 0 ? { screenshots } : {}),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return { version: 1, plugins, uncategorised: uncategorised.sort(), unknownCodes };
}
