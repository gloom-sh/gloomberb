import type { PluginTarget } from "../../../types/plugin";
import { compareSemver, formatVersion, requiredGloomberb } from "../../../utils/semver";
import { runsExternalPlugins } from "../../current-target";
import { BUILTIN_EDITORIAL } from "../../builtin-editorial";
import { builtinPluginGroupMembers } from "../../ownership";
import type { FunctionAccess } from "../../../cli/pane-functions/function-help";
import { PACK_PLUGIN_IDS } from "./packs";

type PluginTier = "official" | "verified" | "community";

/** A command-bar code a registry plugin answers to, such as `POLL`. */
export interface RegistryPluginShortcut {
  code: string;
  name: string;
  description: string;
  /** Built-ins only: what Free gets of it. */
  access?: FunctionAccess;
}

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
  contributes: {
    panes: string[];
    capabilities: string[];
    broker: boolean;
    /** Declared in the plugin's gloom.json, or listed for a built-in; absent from older feeds. */
    shortcuts?: RegistryPluginShortcut[];
  };
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
  /** Full path of that folder, which differs by platform and `GLOOMBERB_HOME`. */
  path?: string;
  /** Checked-out commit, when the install is a git checkout. */
  commit?: string;
  /** A dev link (`gloomberb plugin link`) rather than a clone. */
  linked?: boolean;
  /** Set when the plugin is installed but cannot run on this renderer. */
  unsupportedTarget?: PluginTarget;
  loadError?: string;
  /** The checkout declares a newer Gloomberb than this one, so it was not loaded. */
  needsGloomberb?: string;
  /** Declares a `configSchema` and is missing a required value. */
  needsSetup?: boolean;
  hasSetup?: boolean;
  /** Errors logged through the plugin's scoped logger this session. */
  errorCount?: number;
  lastError?: string;
  /** Registered after startup, or its files changed under a running registration. */
  needsRestart?: boolean;
}

/**
 * `research` holds the built-ins starter packs switch, so a pack's reach is
 * the section above the others; `builtin` the other built-ins.
 */
export type MarketplaceSection = "research" | "builtin" | "installed" | "available";

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
  path?: string;
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
  /** What the installed checkout declares it needs, when this Gloomberb is older. */
  needsGloomberb?: string;
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

function sectionOf(entry: { id: string; installed: boolean; bundled: boolean }): MarketplaceSection {
  if (entry.bundled) return PACK_PLUGIN_IDS.includes(entry.id) ? "research" : "builtin";
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

/** The short line a built-in's row reads: its editorial tagline, else its description. */
function builtinTagline(local: InstalledPlugin): string {
  return BUILTIN_EDITORIAL[local.id]?.tagline ?? local.description ?? "";
}

export function mergeCatalog(options: {
  registry: readonly RegistryPlugin[];
  /** Remote default-branch heads by plugin folder, from `PluginManager.remoteHeads`. */
  remoteHeads?: Readonly<Record<string, string>>;
  installed: readonly InstalledPlugin[];
  target: PluginTarget;
}): MarketplaceEntry[] {
  const { installed, target, remoteHeads } = options;
  // A built-in this build split into several, which a feed generated before
  // the split still lists. Its id now only switches its successors together,
  // and they have rows of their own.
  const registry = options.registry.filter((plugin) => !(plugin.bundled && builtinPluginGroupMembers(plugin.id)));
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
    // The feed lags the app: a built-in this build renamed or redescribed
    // reads the way the running app has it.
    const builtin = local?.source === "builtin" ? local : null;

    const base = {
      // A bundled plugin is present whether or not the local catalog reports it,
      // which matters when the feed is newer than the running build.
      installed: plugin.bundled || !!local,
      // And a plugin this build ships is bundled whatever the feed says: one
      // that is built in again can still be listed under its old repository,
      // and Update or Remove would then act on a leftover checkout.
      bundled: plugin.bundled || local?.source === "builtin",
    };
    entries.push({
      id: plugin.id,
      name: builtin?.name ?? plugin.name,
      tagline: builtin ? builtinTagline(builtin) : plugin.tagline,
      description: builtin?.description ?? plugin.description,
      categories: builtin ? BUILTIN_EDITORIAL[plugin.id]?.categories ?? plugin.categories : plugin.categories,
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
      path: local?.path,
      linked: local?.linked === true,
      installedVersion: local?.version,
      installedCommit: local?.commit,
      availableVersion: plugin.ref,
      availableCommit: plugin.commit,
      remoteCommit: remoteHeadFor(local),
      minGloomberb: plugin.minGloomberb,
      contributes: plugin.contributes,
      loadError: local?.loadError,
      needsGloomberb: local?.needsGloomberb,
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
      section: sectionOf({ id: plugin.id, ...base }),
    });
  }

  // Installed but unlisted: side-loaded from a git URL, or listed under a
  // different id. Still needs to be manageable.
  for (const local of installedById.values()) {
    const base = { installed: true, bundled: local.source === "builtin" };
    entries.push({
      id: local.id,
      name: local.name,
      tagline: local.source === "builtin"
        ? builtinTagline(local)
        : local.description ?? (local.linked ? "Linked from a local checkout" : "Installed outside the registry"),
      description: local.description,
      categories: local.source === "builtin" ? [...BUILTIN_EDITORIAL[local.id]?.categories ?? []] : ["unlisted"],
      // Shipped by Gloom like every built-in, whether or not the feed lists it.
      tier: local.source === "builtin" ? "official" : "community",
      targets: local.unsupportedTarget ? [] : [target],
      hosts: [],
      stars: 0,
      featured: false,
      ...base,
      enabled: local.enabled,
      toggleable: local.toggleable,
      directory: local.directory,
      path: local.path,
      linked: local.linked === true,
      installedVersion: local.version,
      installedCommit: local.commit,
      remoteCommit: remoteHeadFor(local),
      loadError: local.loadError,
      needsGloomberb: local.needsGloomberb,
      needsSetup: local.needsSetup === true,
      hasSetup: local.hasSetup === true,
      errorCount: local.errorCount ?? 0,
      lastError: local.lastError,
      needsRestart: local.needsRestart === true,
      unsupportedHere: !!local.unsupportedTarget,
      section: sectionOf({ id: local.id, ...base }),
    });
  }

  return entries;
}

/** What deciding "is there an update" reads from a row. */
export type UpdateFacts = Pick<
  MarketplaceEntry,
  "installed" | "bundled" | "linked" | "installedVersion" | "installedCommit" | "availableVersion" | "availableCommit" | "remoteCommit"
>;

/** The commit an update would land on: the reviewed one, or the remote's head. */
function targetCommit(entry: UpdateFacts): string | undefined {
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
export function hasUpdate(entry: UpdateFacts): boolean {
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
 * The built-in the research pane, DES and the G charts come from. It can be
 * switched off, after a confirmation, and every starter pack keeps it on.
 */
export const CORE_PLUGIN_ID = "ticker-core";

/**
 * One word for "what should I do about this row". Health outranks state:
 * a plugin that is enabled but failed to load is `failed`, not `enabled`.
 */
export function statusOf(entry: MarketplaceEntry): MarketplaceStatus {
  // Before `failed`: the checkout was never imported, and the fix is updating
  // Gloomberb rather than the plugin.
  if (entry.needsGloomberb) return { kind: "needs-gloomberb", text: `needs ${entry.needsGloomberb}` };
  // Also before `failed`: an update landed over modules this session already
  // imported, so any error on the row is from the old code.
  if (entry.needsRestart) return { kind: "needs-restart", text: "needs restart" };
  if (entry.loadError) return { kind: "failed", text: "failed" };
  const unsupported = unsupportedLabel(entry);
  if (unsupported) return { kind: "unsupported", text: unsupported.toLowerCase() };
  const required = requiredGloomberb(entry.minGloomberb);
  const needsGloomberb: MarketplaceStatus | null = required ? { kind: "needs-gloomberb", text: `needs ${required}` } : null;
  if (!entry.installed) return needsGloomberb ?? { kind: "none", text: "" };
  if (!entry.enabled) return { kind: "disabled", text: "off" };
  if (entry.id === CORE_PLUGIN_ID && entry.bundled) return { kind: "enabled", text: "core" };
  if (entry.needsSetup) return { kind: "needs-setup", text: "needs setup" };
  if (hasUpdate(entry)) return needsGloomberb ?? { kind: "update", text: "update" };
  if (entry.errorCount > 0) return { kind: "errors", text: `errors (${entry.errorCount})` };
  return { kind: "enabled", text: "on" };
}

/** Whether a section lists plugins that ship inside Gloomberb. */
function isBuiltinSection(section: MarketplaceSection): boolean {
  return section === "research" || section === "builtin";
}

/**
 * Sorted for a sectioned list: the research built-ins in pack order, the
 * other built-ins, then installed, then available; within the last two the
 * curated order: featured, then tier, then stars.
 */
export function sortEntries(entries: readonly MarketplaceEntry[]): MarketplaceEntry[] {
  const SECTION_RANK: Record<MarketplaceSection, number> = { research: 0, builtin: 1, installed: 2, available: 3 };
  return [...entries].sort((a, b) => {
    if (a.section !== b.section) return SECTION_RANK[a.section] - SECTION_RANK[b.section];
    if (a.section === "research") return PACK_PLUGIN_IDS.indexOf(a.id) - PACK_PLUGIN_IDS.indexOf(b.id);
    // The other built-ins read alphabetically after the featured one: a
    // repository's stars say nothing about something built in.
    if (a.section === "builtin" && a.featured === b.featured) return a.name.localeCompare(b.name);
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
    // toggleable built-in is, unless the built-in filter is off.
    if (isBuiltinSection(entry.section) && (!entry.toggleable || !options.showBuiltin)) return false;
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
  research: "Research and markets",
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
export function registryPin(
  entry: Pick<MarketplaceEntry, "availableVersion" | "availableCommit">,
): { ref?: string; commit?: string } | undefined {
  if (!entry.availableVersion && !entry.availableCommit) return undefined;
  return {
    ...(entry.availableVersion ? { ref: entry.availableVersion } : {}),
    ...(entry.availableCommit ? { commit: entry.availableCommit } : {}),
  };
}

/**
 * What someone agrees to before a plugin lands on their machine. The Plugins
 * pane and the command bar both ask with this, so an install reads the same
 * wherever it starts.
 */
export function installConsent(
  plugin: Pick<MarketplaceEntry, "name" | "tier" | "hosts"> & { repo: string },
  pin: { ref?: string; commit?: string } | undefined,
): { title: string; body: string[] } {
  return {
    title: `Install ${plugin.name}?`,
    body: [
      `${plugin.name} runs with your full permissions. It is not sandboxed.`,
      `Source: github.com/${plugin.repo}${pin?.ref ? ` at ${pin.ref}` : ""}${pin?.commit ? ` (${pin.commit.slice(0, 7)})` : ""}`,
      plugin.tier === "official" ? "Published by Gloom." : plugin.tier === "verified" ? "Reviewed by Gloom." : "Community plugin, not reviewed.",
      ...(plugin.hosts.length > 0 ? [`Declares access to ${plugin.hosts.join(", ")}.`] : []),
    ],
  };
}
