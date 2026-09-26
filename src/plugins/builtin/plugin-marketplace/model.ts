import type { PluginTarget } from "../../../types/plugin";
import { compareSemver, formatVersion, requiredGloomberb } from "../../../utils/semver";
import { runsExternalPlugins } from "../../current-target";

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
  /** Folder under the plugins directory; absent for built-ins. */
  directory?: string;
  /** Checked-out commit, when the install is a git checkout. */
  commit?: string;
  /** A dev link (`gloomberb plugin link`) rather than a clone. */
  linked?: boolean;
  /** Set when the plugin is installed but cannot run on this renderer. */
  unsupportedTarget?: PluginTarget;
  loadError?: string;
  /** Declares a `configSchema` and is missing a required value. */
  needsSetup?: boolean;
  hasSetup?: boolean;
  /** Errors logged through the plugin's scoped logger this session. */
  errorCount?: number;
  lastError?: string;
  /** Registered after startup, or its files changed under a running registration. */
  needsRestart?: boolean;
}

export type MarketplaceSection = "installed" | "available" | "builtin";

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
  directory?: string;
  linked: boolean;
  installedVersion?: string;
  installedCommit?: string;
  /** The registry's tag, when the plugin is installable. */
  availableVersion?: string;
  availableCommit?: string;
  /**
   * Where the checkout's own remote is, for a plugin the registry does not
   * pin. Filled in by a check the pane runs; absent until it answers.
   */
  remoteCommit?: string;
  minGloomberb?: string;
  contributes?: RegistryPlugin["contributes"];
  loadError?: string;
  needsSetup: boolean;
  hasSetup: boolean;
  errorCount: number;
  lastError?: string;
  needsRestart: boolean;
  /**
   * The plugin cannot run on the current renderer — IBKR Gateway in a browser,
   * for example. Distinct from "not installed": the user may have it installed
   * and working elsewhere.
   */
  unsupportedHere: boolean;
  section: MarketplaceSection;
}

const TIER_RANK: Record<PluginTier, number> = { official: 0, verified: 1, community: 2 };

function sectionOf(entry: { installed: boolean; bundled: boolean }): MarketplaceSection {
  if (entry.bundled) return "builtin";
  return entry.installed ? "installed" : "available";
}

/**
 * Merges the remote catalog with what is actually loaded.
 *
 * Three sources disagree in normal operation and all three matter: the registry
 * knows about plugins the user has not installed, the app knows about plugins
 * the registry has never heard of (installed straight from a git URL), and a
 * plugin can be installed but inert because this renderer cannot run it. The
 * merge keeps all three visible rather than showing whichever list is handy.
 */
/** The folder `gloomberb install owner/repo` creates, which is the repository name. */
function repoDirectory(repo: string | undefined): string | null {
  const name = repo?.split("/")[1]?.replace(/\.git$/, "");
  return name ? name.toLowerCase() : null;
}

export function mergeCatalog(options: {
  registry: readonly RegistryPlugin[];
  /** Remote default-branch heads by plugin folder, from `PluginManager.remoteHeads`. */
  remoteHeads?: Readonly<Record<string, string>>;
  installed: readonly InstalledPlugin[];
  target: PluginTarget;
}): MarketplaceEntry[] {
  const { registry, installed, target, remoteHeads } = options;
  const remoteHeadFor = (local: InstalledPlugin | undefined) => (
    local?.directory ? remoteHeads?.[local.directory] : undefined
  );
  const installedById = new Map(installed.map((entry) => [entry.id, entry]));
  const entries: MarketplaceEntry[] = [];

  // Ids first, so a plugin that reports one is never claimed by a different
  // registry row that happens to share its folder name.
  const localFor = new Map<string, InstalledPlugin>();
  for (const plugin of registry) {
    const byId = installedById.get(plugin.id);
    if (!byId) continue;
    localFor.set(plugin.id, byId);
    installedById.delete(plugin.id);
  }
  // A plugin that failed to import has no id to report, so the loader falls
  // back to its folder name. That folder is the registry's repository name,
  // which is enough to put the failure on the row the user installed from
  // rather than beside it as a second, unlisted plugin.
  for (const plugin of registry) {
    if (localFor.has(plugin.id)) continue;
    const directory = repoDirectory(plugin.repo);
    if (!directory) continue;
    for (const [id, local] of installedById) {
      if (local.source === "external" && (local.directory ?? id).toLowerCase() === directory) {
        localFor.set(plugin.id, local);
        installedById.delete(id);
        break;
      }
    }
  }

  for (const plugin of registry) {
    const local = localFor.get(plugin.id);

    const base = {
      // A bundled plugin is present whether or not the local catalog reports it,
      // which matters when the feed is newer than the running build.
      installed: plugin.bundled || !!local,
      bundled: plugin.bundled,
    };
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
      ...base,
      enabled: local ? local.enabled : plugin.bundled,
      toggleable: local ? local.toggleable : true,
      directory: local?.directory,
      linked: local?.linked === true,
      installedVersion: local?.version,
      installedCommit: local?.commit,
      availableVersion: plugin.ref,
      availableCommit: plugin.commit,
      remoteCommit: remoteHeadFor(local),
      minGloomberb: plugin.minGloomberb,
      contributes: plugin.contributes,
      loadError: local?.loadError,
      needsSetup: local?.needsSetup === true,
      hasSetup: local?.hasSetup === true,
      errorCount: local?.errorCount ?? 0,
      lastError: local?.lastError,
      needsRestart: local?.needsRestart === true,
      // A plugin this renderer loaded is the answer to "does it run here":
      // the loader already applied the targets the installed code declares,
      // which may be newer than what the feed says. Part of the build without
      // a local report, only the feed's targets can say. Anything absent needs
      // a renderer that loads plugins from outside the build, which the web
      // app does not, whatever the plugin declares.
      unsupportedHere: local
        ? !!local.unsupportedTarget
        : plugin.bundled
          ? !plugin.targets.includes(target)
          : !runsExternalPlugins(target) || !plugin.targets.includes(target),
      section: sectionOf(base),
    });
  }

  // Installed but unlisted: side-loaded from a git URL, or listed under a
  // different id. Still needs to be manageable.
  for (const local of installedById.values()) {
    const base = { installed: true, bundled: local.source === "builtin" };
    entries.push({
      id: local.id,
      name: local.name,
      tagline: local.description ?? (local.linked ? "Linked from a local checkout" : "Installed outside the registry"),
      description: local.description,
      categories: local.source === "builtin" ? [] : ["unlisted"],
      tier: "community",
      targets: local.unsupportedTarget ? [] : [target],
      hosts: [],
      stars: 0,
      featured: false,
      ...base,
      enabled: local.enabled,
      toggleable: local.toggleable,
      directory: local.directory,
      linked: local.linked === true,
      installedVersion: local.version,
      installedCommit: local.commit,
      remoteCommit: remoteHeadFor(local),
      loadError: local.loadError,
      needsSetup: local.needsSetup === true,
      hasSetup: local.hasSetup === true,
      errorCount: local.errorCount ?? 0,
      lastError: local.lastError,
      needsRestart: local.needsRestart === true,
      unsupportedHere: !!local.unsupportedTarget,
      section: sectionOf(base),
    });
  }

  return entries;
}

/** The commit an update would land on: the reviewed one, or the remote's head. */
function targetCommit(entry: MarketplaceEntry): string | undefined {
  // A registry-listed plugin moves between reviewed commits, never to whatever
  // its default branch holds today, so its own remote does not get a say.
  if (entry.availableVersion || entry.availableCommit) return entry.availableCommit;
  return entry.remoteCommit;
}

/**
 * Whether there is something newer than what is installed.
 *
 * Versions decide when both sides have one; otherwise the commit an update
 * would land on is compared with the checked-out one. For a plugin the
 * registry lists that is the reviewed commit, and for one it does not it is
 * the remote's default branch, which is exactly where `update` goes. A linked
 * dev checkout is never "behind": the developer's working copy is the source
 * of truth there.
 */
export function hasUpdate(entry: MarketplaceEntry): boolean {
  if (!entry.installed || entry.bundled || entry.linked) return false;
  const byVersion = compareSemver(entry.installedVersion, entry.availableVersion);
  if (byVersion !== null) return byVersion < 0;
  const target = targetCommit(entry);
  if (target && entry.installedCommit) {
    return !entry.installedCommit.toLowerCase().startsWith(target.toLowerCase());
  }
  return false;
}

/**
 * Whether this row's update state can only be answered by asking its remote:
 * installed from git, managed by the host, and not pinned by the registry.
 */
export function needsRemoteCheck(entry: MarketplaceEntry): boolean {
  return entry.installed
    && !entry.bundled
    && !entry.linked
    && !!entry.directory
    && !entry.availableVersion
    && !entry.availableCommit;
}

/** `1.2.0`, or `1.2.0 → 1.3.0` when an update is waiting. */
export function versionLabel(entry: MarketplaceEntry): string {
  const installed = entry.installed ? formatVersion(entry.installedVersion) : null;
  const available = formatVersion(entry.availableVersion);
  if (!entry.installed) return available ?? "";
  if (hasUpdate(entry)) {
    const next = available ?? targetCommit(entry)?.slice(0, 7) ?? "";
    return `${installed ?? entry.installedCommit?.slice(0, 7) ?? "?"} → ${next}`;
  }
  return installed ?? entry.installedCommit?.slice(0, 7) ?? "";
}

export type MarketplaceStatusKind =
  | "failed"
  | "needs-restart"
  | "unsupported"
  | "needs-setup"
  | "update"
  | "needs-gloomberb"
  | "errors"
  | "enabled"
  | "disabled"
  | "none";

export interface MarketplaceStatus {
  kind: MarketplaceStatusKind;
  text: string;
}

/**
 * One word for "what should I do about this row". Health outranks state:
 * a plugin that is enabled but failed to load is `failed`, not `enabled`.
 */
export function statusOf(entry: MarketplaceEntry): MarketplaceStatus {
  if (entry.loadError) return { kind: "failed", text: "failed" };
  if (entry.needsRestart) return { kind: "needs-restart", text: "needs restart" };
  const unsupported = unsupportedLabel(entry);
  if (unsupported) return { kind: "unsupported", text: unsupported.toLowerCase() };
  const required = requiredGloomberb(entry.minGloomberb);
  const needsGloomberb: MarketplaceStatus | null = required ? { kind: "needs-gloomberb", text: `needs ${required}` } : null;
  if (!entry.installed) return needsGloomberb ?? { kind: "none", text: "" };
  if (!entry.enabled) return { kind: "disabled", text: "disabled" };
  if (entry.needsSetup) return { kind: "needs-setup", text: "needs setup" };
  if (hasUpdate(entry)) return needsGloomberb ?? { kind: "update", text: "update" };
  if (entry.errorCount > 0) return { kind: "errors", text: `errors (${entry.errorCount})` };
  return { kind: "enabled", text: "enabled" };
}

/**
 * Sorted for a sectioned list: installed, then available, then built in;
 * within a section the curated order: featured, then tier, then stars.
 */
export function sortEntries(entries: readonly MarketplaceEntry[]): MarketplaceEntry[] {
  const SECTION_RANK: Record<MarketplaceSection, number> = { installed: 0, available: 1, builtin: 2 };
  return [...entries].sort((a, b) => {
    if (a.section !== b.section) return SECTION_RANK[a.section] - SECTION_RANK[b.section];
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.tier !== b.tier) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (a.stars !== b.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

export function filterEntries(
  entries: readonly MarketplaceEntry[],
  options: { query: string; category: string | null; showBuiltin: boolean },
): MarketplaceEntry[] {
  const query = options.query.trim().toLowerCase();

  return entries.filter((entry) => {
    // Core modules with no switch are not something the user manages; a
    // toggleable built-in is, but only on request.
    if (entry.section === "builtin" && (!entry.toggleable || !options.showBuiltin)) return false;
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

export type MarketplaceRow =
  | { type: "header"; section: MarketplaceSection; count: number }
  | { type: "entry"; entry: MarketplaceEntry };

export const SECTION_LABELS: Record<MarketplaceSection, string> = {
  installed: "Installed",
  available: "Available",
  builtin: "Built in",
};

/** Interleaves section headers into an already sorted list. */
export function buildRows(entries: readonly MarketplaceEntry[]): MarketplaceRow[] {
  const rows: MarketplaceRow[] = [];
  let current: MarketplaceSection | null = null;
  for (const entry of entries) {
    if (entry.section !== current) {
      current = entry.section;
      rows.push({ type: "header", section: current, count: entries.filter((other) => other.section === current).length });
    }
    rows.push({ type: "entry", entry });
  }
  return rows;
}

/** Whether this entry can be installed from inside the app right now. */
export function isInstallable(entry: MarketplaceEntry): boolean {
  return !entry.installed && !entry.bundled && !!entry.repo;
}

/** Whether `update` and `remove` can address this entry: it is a folder the host manages. */
export function isManaged(entry: MarketplaceEntry): boolean {
  return entry.installed && !entry.bundled && !!entry.directory;
}

/** Short label for a plugin that cannot run on the current renderer. */
export function unsupportedLabel(entry: MarketplaceEntry): string | null {
  if (!entry.unsupportedHere) return null;
  if (entry.targets.length === 0) return "Unavailable here";
  const desktop = entry.targets.includes("desktop");
  const terminal = entry.targets.includes("cli") || entry.targets.includes("tui");
  if (desktop && terminal) return "Not on web";
  return desktop ? "Desktop only" : "Terminal only";
}

/** The pin the registry asks for, or undefined when it does not pin this plugin. */
export function registryPin(entry: MarketplaceEntry): { ref?: string; commit?: string } | undefined {
  if (!entry.availableVersion && !entry.availableCommit) return undefined;
  return {
    ...(entry.availableVersion ? { ref: entry.availableVersion } : {}),
    ...(entry.availableCommit ? { commit: entry.availableCommit } : {}),
  };
}
