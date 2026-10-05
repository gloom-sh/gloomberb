import { ABSORBED_PLUGINS } from "./absorbed";
import { getPluginCatalog } from "./catalog";

/**
 * The public description of the plugins that ship inside Gloomberb.
 *
 * The plugin directory has to list built-ins alongside installable ones, but a
 * built-in has no repository to read metadata from. Hand-maintaining that half
 * elsewhere meant it silently drifted every time a built-in changed its panes
 * or description, so it is derived from the live catalog here instead and
 * checked against a committed snapshot in CI.
 */

interface BuiltinPluginManifestEntry {
  id: string;
  name: string;
  description: string;
  /** Curated, since the catalog has no notion of categories. */
  categories: string[];
  toggleable: boolean;
  featured?: true;
  /** Path to artwork in this repo, resolved by the directory against HEAD. */
  icon?: string;
  contributes: {
    panes: string[];
    capabilities: string[];
    broker: boolean;
  };
}

/**
 * Editorial metadata the runtime catalog does not carry. Anything missing here
 * is reported by `generate-plugin-manifest.ts` rather than silently defaulted,
 * so a new built-in cannot slip into the directory uncategorised.
 */
const EDITORIAL: Record<
  string,
  { categories: string[]; featured?: true; icon?: string }
> = {
  "gloomberb-cloud": {
    categories: ["data", "cloud"],
    featured: true,
    icon: "plugin-icons/gloomberb-cloud.webp",
  },
  alerts: { categories: ["alerts"] },
  application: { categories: ["core"] },
  broker: { categories: ["broker"] },
  "clinical-trials": { categories: ["research"] },
  "comment-letters": { categories: ["research"] },
  "custom-view": { categories: ["data", "productivity"] },
  debug: { categories: ["developer"] },
  "fear-greed": { categories: ["markets", "sentiment"], icon: "plugin-icons/fear-greed.webp" },
  "ipo-calendar": { categories: ["macro", "markets"], icon: "plugin-icons/ipo-calendar.webp" },
  macro: { categories: ["macro"] },
  "market-halts": { categories: ["markets"], icon: "plugin-icons/market-halts.webp" },
  "market-heatmap": { categories: ["markets"], icon: "plugin-icons/market-heatmap.webp" },
  "market-overview": { categories: ["markets"] },
  news: { categories: ["news"] },
  notes: { categories: ["productivity"] },
  portfolio: { categories: ["portfolio"] },
  "research-search": { categories: ["research", "news"] },
  "ticker-research": { categories: ["research"] },
};

export interface BuiltinManifest {
  version: 1;
  plugins: BuiltinPluginManifestEntry[];
  /** Built-in ids with no editorial entry; a non-empty list fails generation. */
  uncategorised: string[];
}

export function buildBuiltinManifest(): BuiltinManifest {
  const uncategorised: string[] = [];

  const plugins = getPluginCatalog()
    // Built in again, but released apps from before that still install these
    // from their repositories, and the directory drops a repository row whose
    // id a built-in claims. This build shows that row as its built-in, so they
    // join the manifest once those releases have updated.
    .filter(({ plugin }) => !ABSORBED_PLUGINS.some((absorbed) => absorbed.id === plugin.id))
    .map(({ plugin }) => {
      const editorial = EDITORIAL[plugin.id];
      if (!editorial) uncategorised.push(plugin.id);

      return {
        id: plugin.id,
        name: plugin.name,
        description: plugin.description ?? "",
        categories: editorial?.categories ?? [],
        toggleable: plugin.toggleable === true,
        ...(editorial?.featured ? { featured: true as const } : {}),
        ...(editorial?.icon ? { icon: editorial.icon } : {}),
        contributes: {
          panes: (plugin.panes ?? []).map((pane) => pane.id).sort(),
          capabilities: (plugin.capabilities ?? [])
            .map((capability) => {
              const value = capability as { id?: string; kind?: string };
              return value.id ?? value.kind ?? "capability";
            })
            .sort(),
          broker: !!plugin.broker,
        },
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return { version: 1, plugins, uncategorised: uncategorised.sort() };
}
