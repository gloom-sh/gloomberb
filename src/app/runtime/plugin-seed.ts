import type { PluginActivation } from "../../plugins/marketplace/activation";
import {
  getPluginSeedProgress,
  samePluginSeedFailure,
  subscribePluginSeed,
  type PluginSeedNotice,
  type PluginSeedProgress,
  type PluginSeedRecord,
} from "../../plugins/seed-progress";
import type { AppConfig } from "../../types/config";
import { logFailure } from "../../utils/log-failure";

/**
 * Brings the plugins the launch restores (cli/restore-plugins.ts) into the
 * running app as each lands, the way the Plugins pane does after an install,
 * then records the outcome in the config and says what could not be
 * installed. The main window alone does this: it owns the config and the
 * plugin registrations.
 */
export interface PluginSeedConsumer {
  /** Settles once the plugins the app started with have registered. */
  ready: Promise<unknown>;
  /** Brings an installed folder, and the siblings it brought along, into the session. Null when nothing can. */
  activate(install: { directory: string; peers: string[] }): Promise<PluginActivation | null>;
  /** Whether the plugin in this folder already runs in the session. */
  isRunning(directory: string): boolean;
  record(record: PluginSeedRecord): void;
  notify(notice: PluginSeedNotice): void;
}

/** Folders being brought in, across consumers: a remounted app must not register one twice. */
const activating = new Set<string>();

/** `TV, Polls and Substack`. */
function nameList(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Follows the restore until it is over, or until the returned function is called. */
export function startPluginSeedConsumer(consumer: PluginSeedConsumer): () => void {
  const handled = new Set<string>();
  const unloaded: string[] = [];
  const restart: string[] = [];
  let finished = false;
  let disposed = false;
  // One at a time, in the order they landed: a sibling before what needs it.
  let chain: Promise<void> = consumer.ready.then(() => {}, () => {
    // Intentional ignore: a plugin that failed to register is reported where it registers.
  });

  const bringIn = async (name: string, directory: string, peers: string[]) => {
    if (disposed || activating.has(directory) || consumer.isRunning(directory)) return;
    activating.add(directory);
    try {
      const activated = await consumer.activate({ directory, peers: peers.filter((peer) => !consumer.isRunning(peer)) });
      // Nothing here can load it (no plugin manager): the next launch does.
      if (!activated || (activated.ok && activated.restart)) restart.push(name);
      else if (!activated.ok) unloaded.push(name);
    } finally {
      activating.delete(directory);
    }
  };

  const finish = (outcome: NonNullable<PluginSeedProgress["outcome"]>) => {
    if (disposed) return;
    consumer.record(outcome.record);
    if (outcome.notice) consumer.notify(outcome.notice);
    if (unloaded.length > 0) consumer.notify({ type: "error", body: `${nameList(unloaded)} installed but did not load. Open Plugins to see why.` });
    else if (restart.length > 0) consumer.notify({ type: "info", body: `Restart Gloom to finish installing ${nameList(restart)}.` });
  };

  const step = () => {
    const progress = getPluginSeedProgress();
    if (!progress || disposed) return;
    for (const entry of progress.plugins) {
      if (entry.state !== "installed" || !entry.directory || handled.has(entry.id)) continue;
      handled.add(entry.id);
      const { name, directory } = entry;
      chain = chain.then(() => bringIn(name, directory, entry.peers ?? []))
        .catch(logFailure("plugin-seed", "Restored plugin activation failed"));
    }
    const { outcome } = progress;
    if (outcome && !finished) {
      finished = true;
      chain = chain.then(() => finish(outcome)).catch(logFailure("plugin-seed", "Plugin restore record failed"));
    }
  };

  const unsubscribe = subscribePluginSeed(step);
  step();
  return () => {
    disposed = true;
    unsubscribe();
  };
}

/**
 * The config with the restore's record: every plugin seeded so far stays
 * seeded, and the failure is this launch's. Null when that changes nothing.
 */
export function withPluginSeedRecord(config: AppConfig, record: PluginSeedRecord): AppConfig | null {
  const seededPlugins = [...new Set([...config.seededPlugins ?? [], ...record.seededPlugins ?? []])].sort();
  const sameSeeded = seededPlugins.join() === [...new Set(config.seededPlugins ?? [])].sort().join();
  if (sameSeeded && samePluginSeedFailure(config.pluginSeedFailure, record.pluginSeedFailure)) return null;
  const next: AppConfig = { ...config, seededPlugins };
  if (record.pluginSeedFailure) next.pluginSeedFailure = record.pluginSeedFailure;
  else delete next.pluginSeedFailure;
  return next;
}
