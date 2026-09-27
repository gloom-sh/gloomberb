import type { AppConfig } from "../types/config";
import { requiredGloomberb } from "../utils/semver";
import { VERSION } from "../version";
import { applicationPluginMeta } from "./builtin/builtin-plugin-meta";
import { hasUpdate, type RegistryPlugin } from "./builtin/plugin-marketplace/model";
import type { PluginOperationResult, PluginPin } from "./builtin/plugin-marketplace/store";

/**
 * Keeps official plugins current without their users having to.
 *
 * Gloomberb updates itself, but a plugin moves only when it is updated, so a
 * host release that retires an API would strand every checkout still using
 * it. Plugins Gloom publishes (registry entries whose repository gloom-sh
 * owns) therefore update in the background: once after Gloomberb itself
 * changed version, then at most once a day, and at startup for one that
 * failed to load on a host export this build does not have.
 *
 * An automatic update takes the same guards as the Plugins pane's: it only
 * moves forward, never to code this Gloomberb is too old for, never over a
 * linked or locally edited checkout, and peers first. Third-party plugins,
 * and anything installed from a repository the registry does not list, are
 * left to their users.
 */

export const OFFICIAL_PLUGIN_OWNER = "gloom-sh";

/**
 * The Plugins pane setting, kept in the config of the built-in plugin that
 * owns the pane. Absent means on.
 */
export const PLUGIN_AUTO_UPDATE_SETTING = { pluginId: applicationPluginMeta.id, key: "autoUpdateOfficialPlugins" } as const;

export function pluginAutoUpdateEnabled(config: Pick<AppConfig, "pluginConfig"> | null | undefined): boolean {
  const { pluginId, key } = PLUGIN_AUTO_UPDATE_SETTING;
  return config?.pluginConfig?.[pluginId]?.[key] !== false;
}

export function isOfficialPluginRepo(repo: string | null | undefined): boolean {
  return repo?.split("/")[0]?.toLowerCase() === OFFICIAL_PLUGIN_OWNER;
}

/** An installed plugin folder, as it is on disk. */
export interface PluginCheckout {
  directory: string;
  /** `owner/repo` of its origin remote; null for anything that is not a GitHub clone. */
  repo: string | null;
  commit: string | null;
  /** package.json `version`. */
  version: string | null;
  linked: boolean;
  /** The Gloomberb the checkout declares it needs, when this one is older. */
  needsGloomberb: string | null;
  /** Folders of the installed sibling plugins it declares as peers. */
  peers: string[];
  /** Declares runtime dependencies, which only `bun install` can fetch. */
  hasDependencies: boolean;
}

export interface PluginAutoUpdateDeps {
  checkouts(): Promise<PluginCheckout[]>;
  /** The registry's plugins, or null when it could not be read. */
  registry(): Promise<readonly RegistryPlugin[] | null>;
  /** Where the checkout's remote default branch is, for a plugin the registry does not pin. */
  remoteHead(directory: string): Promise<string | null>;
  hasLocalChanges(directory: string): Promise<boolean>;
  /** Whether `bun` is there to install a plugin's dependencies. */
  hasBun(): boolean;
  update(directory: string, pin: PluginPin | undefined): Promise<PluginOperationResult>;
  log(message: string): void;
  hostVersion?: string;
}

export interface PluginAutoUpdateResult {
  /** False when the registry could not be read, so nothing was decided. */
  checked: boolean;
  /** Folders whose checkout moved to a newer commit. */
  updated: string[];
}

interface Candidate {
  checkout: PluginCheckout;
  pin: PluginPin | undefined;
}

/** Peers before the plugins that declare them, so a dependent never lands ahead of the peer version it needs. */
function peersFirst(candidates: readonly Candidate[]): Candidate[] {
  const byDirectory = new Map(candidates.map((candidate) => [candidate.checkout.directory, candidate]));
  const ordered: Candidate[] = [];
  const seen = new Set<string>();
  const visit = (candidate: Candidate) => {
    if (seen.has(candidate.checkout.directory)) return;
    seen.add(candidate.checkout.directory);
    for (const peer of candidate.checkout.peers) {
      const dependency = byDirectory.get(peer);
      if (dependency) visit(dependency);
    }
    ordered.push(candidate);
  };
  candidates.forEach(visit);
  return ordered;
}

/**
 * Updates every official plugin that has a newer compatible version, or only
 * the folders in `only`. Never throws for one plugin: a failure is logged and
 * the rest carry on, except a plugin whose peer had an update it did not get.
 */
export async function runPluginAutoUpdate(
  deps: PluginAutoUpdateDeps,
  only?: readonly string[],
): Promise<PluginAutoUpdateResult> {
  const registry = await deps.registry();
  if (!registry) {
    deps.log("Skipped the plugin update check: the plugin registry is unreachable.");
    return { checked: false, updated: [] };
  }
  const listings = new Map(
    registry.filter((plugin) => plugin.repo).map((plugin) => [plugin.repo!.toLowerCase(), plugin]),
  );
  const hostVersion = deps.hostVersion ?? VERSION;
  const candidates: Candidate[] = [];
  // Had a newer version and did not get it, so a plugin built on it waits too.
  const held = new Set<string>();
  const skip = (directory: string, reason: string) => {
    held.add(directory);
    deps.log(`Not updating ${directory}: ${reason}.`);
  };

  for (const checkout of await deps.checkouts()) {
    const { directory } = checkout;
    if (only && !only.includes(directory)) continue;
    const listing = checkout.repo ? listings.get(checkout.repo.toLowerCase()) : undefined;
    // Third-party and unlisted plugins are their users' to update.
    if (!listing || !isOfficialPluginRepo(listing.repo)) continue;
    if (checkout.linked) {
      deps.log(`Not updating ${directory}: it is linked to a local checkout.`);
      continue;
    }
    const required = requiredGloomberb(listing.minGloomberb, hostVersion) ?? checkout.needsGloomberb;
    if (required) {
      deps.log(`Not updating ${directory}: it needs Gloomberb ${required}, this is ${hostVersion}.`);
      continue;
    }
    const pin: PluginPin | undefined = listing.ref || listing.commit
      ? { ...(listing.ref ? { ref: listing.ref } : {}), ...(listing.commit ? { commit: listing.commit } : {}) }
      : undefined;
    // The same test the Plugins pane uses for its `update` status.
    const newer = hasUpdate({
      installed: true,
      bundled: false,
      linked: false,
      installedVersion: checkout.version ?? undefined,
      installedCommit: checkout.commit ?? undefined,
      availableVersion: listing.ref,
      availableCommit: listing.commit,
      remoteCommit: pin ? undefined : (await deps.remoteHead(directory)) ?? undefined,
    });
    if (!newer) continue;
    if (await deps.hasLocalChanges(directory)) {
      skip(directory, "it has local changes");
      continue;
    }
    if (checkout.hasDependencies && !deps.hasBun()) {
      skip(directory, "bun is not on PATH to install its dependencies");
      continue;
    }
    candidates.push({ checkout, pin });
  }

  const updated: string[] = [];
  for (const { checkout, pin } of peersFirst(candidates)) {
    const { directory } = checkout;
    const heldPeer = checkout.peers.find((peer) => held.has(peer));
    if (heldPeer) {
      skip(directory, `its peer ${heldPeer} was not updated`);
      continue;
    }
    const result = await deps.update(directory, pin);
    if (!result.ok) {
      held.add(directory);
      deps.log(`Updating ${directory} failed: ${result.error}`);
    } else if (result.kept) {
      deps.log(`Kept ${directory}: ${result.kept}.`);
    } else if (result.changed !== false) {
      deps.log(`Updated ${directory}.`);
      updated.push(directory);
    }
  }
  return { checked: true, updated };
}

const DAY_MS = 24 * 60 * 60_000;

/** What the last full check left behind, so the schedule holds across launches. */
export interface PluginAutoUpdateState {
  /** When it last read the registry. */
  checkedAt: number;
  /** The Gloomberb that ran it. */
  hostVersion: string;
}

/** A full check is due once on every new Gloomberb version, and then once a day. */
export function pluginAutoUpdateDue(
  state: PluginAutoUpdateState | null,
  now: number,
  hostVersion: string = VERSION,
): boolean {
  if (!state || state.hostVersion !== hostVersion) return true;
  return now - state.checkedAt >= DAY_MS;
}

export interface PluginAutoUpdateSchedule {
  isEnabled(): boolean | Promise<boolean>;
  run(only?: readonly string[]): Promise<PluginAutoUpdateResult>;
  /** Plugin folders that failed to load on a missing host export this session. */
  missingHostExports(): readonly string[];
  readState(): PluginAutoUpdateState | null;
  writeState(state: PluginAutoUpdateState): void;
  onUpdated(directories: string[]): void | Promise<void>;
  log(message: string): void;
  now?(): number;
  hostVersion?: string;
}

/**
 * One pass of the schedule. A full check runs when one is due; at startup,
 * plugins that failed on a missing host export are checked even when it is
 * not, since a newer version is what would fix them. Passes never overlap.
 */
export function createPluginAutoUpdateScheduler(schedule: PluginAutoUpdateSchedule): { tick(startup: boolean): Promise<void> } {
  let running = false;
  return {
    async tick(startup) {
      if (running) return;
      running = true;
      try {
        if (!(await schedule.isEnabled())) return;
        const now = schedule.now?.() ?? Date.now();
        const hostVersion = schedule.hostVersion ?? VERSION;
        const due = pluginAutoUpdateDue(schedule.readState(), now, hostVersion);
        const only = due ? undefined : startup ? schedule.missingHostExports() : [];
        if (only && only.length === 0) return;
        const result = await schedule.run(only);
        // Offline is not a check: the next pass tries again.
        if (due && result.checked) schedule.writeState({ checkedAt: now, hostVersion });
        if (result.updated.length > 0) await schedule.onUpdated(result.updated);
      } catch (error) {
        schedule.log(`The plugin update check failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
    },
  };
}

/** Well after the first frame and the startup data loads. */
const STARTUP_DELAY_MS = 15_000;
/** How often to look whether a day has passed; the check itself runs daily. */
const POLL_INTERVAL_MS = 60 * 60_000;

/** Runs the schedule until the returned function is called. The timers never keep a process alive. */
export function startPluginAutoUpdates(schedule: PluginAutoUpdateSchedule): () => void {
  const scheduler = createPluginAutoUpdateScheduler(schedule);
  const startup = setTimeout(() => { void scheduler.tick(true); }, STARTUP_DELAY_MS);
  const interval = setInterval(() => { void scheduler.tick(false); }, POLL_INTERVAL_MS);
  startup.unref?.();
  interval.unref?.();
  return () => {
    clearTimeout(startup);
    clearInterval(interval);
  };
}
