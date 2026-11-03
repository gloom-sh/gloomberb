import { saveConfig } from "../data/config/store";
import { loadCliConfigIfAvailable } from "./context";
import { getPluginsDir } from "../plugins/loader";
import {
  classifyExtractedPlugins,
  pluginSeedFailure,
  pluginSeedNotice,
  seedExtractedPlugins,
} from "../plugins/extracted-plugins";
import type { PluginDirectoryInfo, PluginInstallOptions, RegistryListing } from "../plugins/installer";
import { publishPluginSeedProgress, samePluginSeedFailure, type PluginSeedEntry, type PluginSeedProgress, type PluginSeedRecord } from "../plugins/seed-progress";
import { debugLog } from "../utils/debug-log";
import type { AppConfig } from "../types/config";
import { withDeadline } from "../utils/async-deadline";

const log = debugLog.createLogger("plugin-seed");

/**
 * How long the restore waits for the plugin registry before it gives up on
 * the plugins left to install. A connection that hangs there would hang the
 * clones the same way; they are retried at the next launch.
 */
const REGISTRY_WAIT_MS = 8_000;
/**
 * How long one git command or dependency install of the restore may run. A
 * clone of one of these plugins takes seconds; one that stalls is stopped
 * here, its plugin counts as not installed, and the next launch tries again.
 */
const INSTALL_STEP_LIMIT_MS = 120_000;

/** What the restore runs: git and the installer, injected so a test can stand in for them. */
export interface PluginSeedDeps {
  gitInstalled(): boolean;
  loadRegistryListings(): Promise<Map<string, RegistryListing>>;
  installListedPlugin(ref: string, options: PluginInstallOptions, listings: ReadonlyMap<string, RegistryListing>): Promise<PluginDirectoryInfo>;
}

// Loaded only when something is left to install: nothing else on the startup path needs it.
const installerDeps = async (): Promise<PluginSeedDeps> => {
  const installer = await import("../plugins/installer");
  return {
    gitInstalled: installer.gitInstalled,
    loadRegistryListings: installer.loadRegistryListings,
    installListedPlugin: installer.installListedPlugin,
  };
};

export interface PluginSeedLaunch {
  /**
   * The config's record as of the plan, already saved: plugins found settled
   * (installed by hand, switched off before the move), and git missing. A
   * caller that read its config earlier merges it in.
   */
  record: PluginSeedRecord;
  /**
   * Installs what is left, one plugin at a time, publishing each change
   * (seed-progress.ts), and resolves with the record to keep once all have
   * settled. The app records it; nothing here saves it. Null when nothing is
   * left to install.
   */
  start: (() => Promise<PluginSeedRecord>) | null;
}

/** Across every restore this process runs, so a later one's changes are never taken for stale. */
let progressSeq = 0;

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Plans the restore of plugins that moved out of this repository into their
 * own, before the app starts. Reads the config and the plugins folder only,
 * so it takes milliseconds and works offline: the installs themselves run
 * once the app is drawn (`start`), and the app brings each plugin in as it
 * lands, its saved panes appearing where they were.
 *
 * Never throws and never prints: the terminal app is about to own the screen.
 * Null on a first run, which has nothing to restore.
 */
export async function prepareExtractedPluginSeed(deps?: PluginSeedDeps): Promise<PluginSeedLaunch | null> {
  try {
    const config = await loadCliConfigIfAvailable();
    // No data directory yet means a first run: there is nothing to restore.
    if (!config) return null;
    const pluginsDir = getPluginsDir();
    const { pending, settled } = classifyExtractedPlugins(config, pluginsDir);
    const resolved = pending.length > 0 ? deps ?? await installerDeps() : null;
    // Without git every clone fails the same way, so none is tried.
    const gitMissing = !!resolved && !resolved.gitInstalled();
    const record: PluginSeedRecord = {
      seededPlugins: sortedIds([...config.seededPlugins ?? [], ...settled]),
      pluginSeedFailure: pending.length === 0 ? undefined
        : gitMissing ? pluginSeedFailure(pending.map((entry) => entry.id), true) : config.pluginSeedFailure,
    };
    if (record.seededPlugins!.join() !== sortedIds(config.seededPlugins ?? []).join()
      || !samePluginSeedFailure(record.pluginSeedFailure, config.pluginSeedFailure)) {
      await saveConfig({ ...config, ...record });
    }
    if (!resolved) return { record, start: null };

    const plugins: PluginSeedEntry[] = pending.map((entry) => ({
      id: entry.id,
      name: entry.name,
      state: gitMissing ? "failed" : "installing",
    }));
    const publish = (outcome?: PluginSeedProgress["outcome"]) => publishPluginSeedProgress({
      seq: ++progressSeq,
      plugins: plugins.map((entry) => ({ ...entry })),
      ...(outcome ? { outcome } : {}),
    });
    if (gitMissing) {
      publish({ record, notice: pluginSeedNotice(record.pluginSeedFailure, config.pluginSeedFailure) });
      return { record, start: null };
    }
    publish();
    return { record, start: () => installPending(config, plugins, publish, resolved) };
  } catch (error) {
    log.error(`Plugin restore skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function installPending(
  config: AppConfig,
  plugins: PluginSeedEntry[],
  publish: (outcome?: PluginSeedProgress["outcome"]) => void,
  deps: PluginSeedDeps,
): Promise<PluginSeedRecord> {
  let listings: Promise<Map<string, RegistryListing>> | undefined;
  const result = await seedExtractedPlugins(config, async (repo) => {
    // Through the registry like `gloom install`: the reviewed commit, and
    // nothing on a Gloomberb too old for it. That failure is retried at the
    // next launch, by when this Gloomberb has usually updated itself. Only no
    // answer at all stops every install: the network hangs, and a clone would
    // too. A registry that fails is not silent: the plugins install from
    // their repositories. Quiet: git's or bun's output would land on the
    // terminal app's screen.
    listings ??= withDeadline(deps.loadRegistryListings(), REGISTRY_WAIT_MS, "the plugin registry did not answer");
    const installed = await deps.installListedPlugin(repo, {
      quiet: true,
      timeoutMs: INSTALL_STEP_LIMIT_MS,
      requireDependencies: true,
    }, await listings);
    return { directory: installed.directory, ...(installed.peers?.length ? { peers: installed.peers } : {}) };
  }, getPluginsDir(), (id, installed) => {
    const entry = plugins.find((candidate) => candidate.id === id);
    if (!entry) return;
    if (installed) Object.assign(entry, { state: "installed", ...installed });
    else entry.state = "failed";
    publish();
  });
  // Recorded, so doctor knows a launch tried, and a failure the next launch
  // retries is not announced again while it lasts.
  const failure = pluginSeedFailure(result.failed, false);
  const record: PluginSeedRecord = { seededPlugins: sortedIds(result.seeded), pluginSeedFailure: failure };
  publish({ record, notice: pluginSeedNotice(failure, config.pluginSeedFailure) });
  if (result.installed.length > 0) log.info(`Restored ${result.installed.join(", ")} into ${getPluginsDir()}`);
  return record;
}

/**
 * The whole restore, awaited, with its record saved: for a script that
 * prepares a profile (the startup benchmarks) rather than an app that keeps
 * running while plugins install.
 *
 * @knipignore Imported by the scripts scripts/benchmark-startup.ts and scripts/desktop-measure/measure.ts run with `bun -e`.
 */
export async function restoreExtractedPlugins(): Promise<PluginSeedRecord | null> {
  const launch = await prepareExtractedPluginSeed();
  if (!launch?.start) return launch?.record ?? null;
  const record = await launch.start();
  const config = await loadCliConfigIfAvailable();
  if (config) await saveConfig({ ...config, ...record });
  return record;
}
