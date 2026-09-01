import type { PluginTarget } from "../../../types/plugin";

export type PluginTier = "official" | "verified" | "community";

/** One record from https://plugins.gloom.sh/registry.json. */
export interface RegistryPlugin {
  id: string;
  name: string;
  tagline: string;
  description?: string;
  repo?: string;
  ref?: string;
  commit?: string;
  author: { name: string; github?: string };
  categories: string[];
  targets: PluginTarget[];
  hosts: string[];
  contributes: { panes: string[]; capabilities: string[]; broker: boolean };
  minGloomberb?: string;
  tier: PluginTier;
  bundled: boolean;
  featured?: boolean;
  stars: number;
  updatedAt?: string;
  readme?: string;
}

export interface RegistryFeed {
  version: number;
  generatedAt: string;
  plugins: RegistryPlugin[];
}

/** What the app knows about a plugin it has actually loaded. */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  toggleable: boolean;
  enabled: boolean;
  source: "builtin" | "external";
  /** Set when the plugin is installed but cannot run on this renderer. */
  unsupportedTarget?: PluginTarget;
  loadError?: string;
}

export interface MarketplaceEntry {
  id: string;
  name: string;
  tagline: string;
  description?: string;
  categories: string[];
  tier: PluginTier;
  targets: PluginTarget[];
  hosts: string[];
  repo?: string;
  stars: number;
  featured: boolean;
  /** Ships inside Gloomberb; there is nothing to install or remove. */
  bundled: boolean;
  installed: boolean;
  enabled: boolean;
  toggleable: boolean;
  installedVersion?: string;
  /** The registry's tag, when the plugin is installable. */
  availableVersion?: string;
  contributes?: RegistryPlugin["contributes"];
  loadError?: string;
  /**
   * The plugin cannot run on the current renderer — IBKR Gateway in a browser,
   * for example. Distinct from "not installed": the user may have it installed
   * and working elsewhere.
   */
  unsupportedHere: boolean;
}

const TIER_RANK: Record<PluginTier, number> = { official: 0, verified: 1, community: 2 };

/**
 * Merges the remote catalog with what is actually loaded.
 *
 * Three sources disagree in normal operation and all three matter: the registry
 * knows about plugins the user has not installed, the app knows about plugins
 * the registry has never heard of (installed straight from a git URL), and a
 * plugin can be installed but inert because this renderer cannot run it. The
 * merge keeps all three visible rather than showing whichever list is handy.
 */
export function mergeCatalog(options: {
  registry: readonly RegistryPlugin[];
  installed: readonly InstalledPlugin[];
  target: PluginTarget;
}): MarketplaceEntry[] {
  const { registry, installed, target } = options;
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  const entries: MarketplaceEntry[] = [];

  for (const plugin of registry) {
    const local = installedById.get(plugin.id);
    installedById.delete(plugin.id);

    entries.push({
      id: plugin.id,
      name: plugin.name,
      tagline: plugin.tagline,
      description: plugin.description,
      categories: plugin.categories,
      tier: plugin.tier,
      targets: plugin.targets,
      hosts: plugin.hosts,
      repo: plugin.repo,
      stars: plugin.stars,
      featured: plugin.featured === true,
      bundled: plugin.bundled,
      // A bundled plugin is present whether or not the local catalog reports it,
      // which matters when the feed is newer than the running build.
      installed: plugin.bundled || !!local,
      enabled: local ? local.enabled : plugin.bundled,
      toggleable: local ? local.toggleable : true,
      installedVersion: local?.version,
      availableVersion: plugin.ref,
      contributes: plugin.contributes,
      loadError: local?.loadError,
      unsupportedHere: !plugin.targets.includes(target),
    });
  }

  // Installed but unlisted: side-loaded from a git URL, or listed under a
  // different id. Still needs to be manageable.
  for (const local of installedById.values()) {
    entries.push({
      id: local.id,
      name: local.name,
      tagline: local.description ?? "Installed outside the registry",
      description: local.description,
      categories: ["unlisted"],
      tier: "community",
      targets: local.unsupportedTarget ? [] : [target],
      hosts: [],
      stars: 0,
      featured: false,
      bundled: local.source === "builtin",
      installed: true,
      enabled: local.enabled,
      toggleable: local.toggleable,
      installedVersion: local.version,
      loadError: local.loadError,
      unsupportedHere: !!local.unsupportedTarget,
    });
  }

  return entries;
}

/**
 * One ordered list rather than an installed/available split.
 *
 * What you already have is what you act on most, so it sorts to the top; the
 * rest of the catalog continues below without a mode switch to find it. Within
 * each half the order is the curated one: featured, then tier, then stars.
 */
export function sortEntries(entries: readonly MarketplaceEntry[]): MarketplaceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (a.stars !== b.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

export function filterEntries(
  entries: readonly MarketplaceEntry[],
  options: { query: string; category: string | null },
): MarketplaceEntry[] {
  const query = options.query.trim().toLowerCase();

  return entries.filter((entry) => {
    if (options.category && !entry.categories.includes(options.category)) return false;
    if (!query) return true;
    return [entry.name, entry.id, entry.tagline, entry.description, ...entry.categories]
      .some((field) => typeof field === "string" && field.toLowerCase().includes(query));
  });
}

export function collectCategories(entries: readonly MarketplaceEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const category of entry.categories) seen.add(category);
  }
  return [...seen].sort();
}

/** Whether this entry can be installed from inside the app right now. */
export function isInstallable(entry: MarketplaceEntry): boolean {
  return !entry.installed && !entry.bundled && !!entry.repo;
}

/** Short label for a plugin that cannot run on the current renderer. */
export function unsupportedLabel(entry: MarketplaceEntry): string | null {
  if (!entry.unsupportedHere) return null;
  if (entry.targets.length === 0) return "Unavailable here";
  return entry.targets.includes("desktop") ? "Desktop only" : "Terminal only";
}
