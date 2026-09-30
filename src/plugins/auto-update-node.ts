import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { debugLog } from "../utils/debug-log";
import {
  runPluginAutoUpdate,
  startPluginAutoUpdates,
  type PluginAutoUpdateDeps,
  type PluginAutoUpdateState,
  type PluginCheckout,
} from "./auto-update";
import type { PluginManager } from "./builtin/plugin-marketplace/store";
import { checkPluginCompatibility, readPluginManifest } from "./compat";
import { installedPeerPlugins } from "./host-link";
import { getPluginCacheDir, getPluginsDir, pluginsMissingHostExports, readPluginCommit } from "./loader";
import { bunCommand } from "./dependencies";

/**
 * Automatic plugin updates for a process that can run git and bun: the
 * terminal, and the desktop's Bun side. The schedule and the rules are in
 * auto-update.ts; this reads the plugins folder and runs the installer.
 */

const log = debugLog.createLogger("plugin-updates");

// Loaded on first use: the first pass runs well after startup.
const installer = () => import("./installer");

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readCheckouts(): Promise<PluginCheckout[]> {
  const { installedPluginDirectories, readPluginRemote } = await installer();
  const pluginsDir = getPluginsDir();
  return installedPluginDirectories().map((directory) => {
    const dir = join(pluginsDir, directory);
    const pkg = readJson(join(dir, "package.json"));
    const dependencies = pkg?.dependencies;
    return {
      directory,
      id: readPluginManifest(dir).id,
      repo: existsSync(join(dir, ".git")) ? readPluginRemote(dir) : null,
      commit: readPluginCommit(dir),
      version: typeof pkg?.version === "string" ? pkg.version : null,
      linked: lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink() === true,
      needsGloomberb: checkPluginCompatibility(dir)?.needsGloomberb ?? null,
      peers: installedPeerPlugins(dir, pluginsDir).map((peer) => peer.directory),
      hasDependencies: !!dependencies && typeof dependencies === "object" && Object.keys(dependencies).length > 0,
    };
  });
}

function createNodeAutoUpdateDeps(manager: PluginManager): PluginAutoUpdateDeps {
  return {
    checkouts: readCheckouts,
    registry: async () => {
      const { loadRegistry } = await import("./builtin/plugin-marketplace/feed");
      const feed = await loadRegistry();
      return feed.error && feed.plugins.length === 0 ? null : feed.plugins;
    },
    remoteHead: async (directory) => (await installer()).readPluginRemoteHead(directory),
    hasLocalChanges: async (directory) => (await installer()).hasLocalChanges(join(getPluginsDir(), directory)),
    hasBun: () => bunCommand() !== null,
    update: (directory, pin) => manager.update(directory, pin),
    log: (message) => log.info(message),
  };
}

const stateFile = () => join(getPluginCacheDir(), "auto-update.json");

function readState(): PluginAutoUpdateState | null {
  const value = readJson(stateFile());
  return value && typeof value.checkedAt === "number" && typeof value.hostVersion === "string"
    ? { checkedAt: value.checkedAt, hostVersion: value.hostVersion }
    : null;
}

function writeState(state: PluginAutoUpdateState): void {
  try {
    mkdirSync(getPluginCacheDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch (error) {
    log.warn(`Could not record the plugin update check: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface NodePluginAutoUpdateOptions {
  /** The manager the Plugins pane uses in this process, so both update the same way. */
  manager: PluginManager;
  /** Read on every pass, so turning the setting off stops the next one. */
  isEnabled(): boolean | Promise<boolean>;
  /** Brings the updated plugins into the running session. */
  onUpdated(directories: string[]): void | Promise<void>;
}

/** Starts automatic updates of official plugins; returns the function that stops them. */
export function startNodePluginAutoUpdates(options: NodePluginAutoUpdateOptions): () => void {
  const deps = createNodeAutoUpdateDeps(options.manager);
  return startPluginAutoUpdates({
    isEnabled: options.isEnabled,
    run: (only) => runPluginAutoUpdate(deps, only),
    missingHostExports: pluginsMissingHostExports,
    readState,
    writeState,
    onUpdated: options.onUpdated,
    log: (message) => log.warn(message),
  });
}
