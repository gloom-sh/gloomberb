import { readdir, rm, stat } from "fs/promises";
import { existsSync, lstatSync } from "fs";
import { basename, join } from "path";

import type {
  DesktopExternalPluginBundle,
  DesktopPluginActivationResult,
  DesktopPluginOperationResult,
  DesktopPluginPin,
} from "../shared/protocol";
import { bundleExternalPlugin, pluginBundleCacheDir } from "../../../plugins/bundle";
import { linkHostPackages } from "../../../plugins/host-link";
import {
  getPluginCacheDir,
  getPluginsDir,
  listPluginDirectories,
  loadExternalPlugin,
  readPluginCommit,
  resolvePluginEntry,
} from "../../../plugins/loader";
import type { PluginRegistry } from "../../../plugins/registry";
import { desktopRendererCapabilityManifests } from "./desktop/initialization";
import type { GloomPlugin } from "../../../types/plugin";
import { debugLog } from "../../../utils/debug-log";

const log = debugLog.createLogger("desktop-plugins");

/**
 * Prepares external plugins for the desktop view.
 *
 * The view is a browser context and cannot read `~/.gloomberb/plugins`, so the
 * Bun process does both halves here: it imports each plugin natively to read
 * its metadata, and compiles it to an ES module the view can evaluate.
 *
 * Bundling is cached against the newest mtime in the plugin directory. Without
 * that, every window open would recompile every plugin, which is slow enough to
 * be visible at startup.
 */

interface CacheEntry {
  mtimeMs: number;
  code: string;
}

const bundleCache = new Map<string, CacheEntry>();

async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const info = await stat(full);
      if (info.mtimeMs > newest) newest = info.mtimeMs;
    }
  };
  await walk(dir, 0);
  return newest;
}

async function readPluginMetadata(entryFile: string, fresh = false): Promise<GloomPlugin | null> {
  try {
    // Fresh after an update, otherwise Bun hands back the module it cached
    // for the previous version and the metadata lags the code.
    const mod = await import(fresh ? `${entryFile}?reload=${Date.now()}` : entryFile);
    const plugin: GloomPlugin = mod.default ?? mod.plugin;
    return plugin?.id && plugin?.name ? plugin : null;
  } catch (error) {
    log.error(`Metadata read failed for ${entryFile}: ${error}`);
    return null;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function bundlePluginDirectory(
  pluginsDir: string,
  directory: string,
  options: { fresh?: boolean } = {},
): Promise<DesktopExternalPluginBundle | null> {
  const pluginDir = join(pluginsDir, directory);
  const entryFile = await resolvePluginEntry(pluginDir);
  if (!entryFile) return null;

  linkHostPackages(pluginDir);

  const plugin = await readPluginMetadata(entryFile, options.fresh);
  const commit = readPluginCommit(pluginDir);
  const base = {
    id: plugin?.id ?? directory,
    name: plugin?.name ?? directory,
    // Empty rather than a made-up number when the plugin could not be read.
    version: plugin?.version ?? "",
    path: pluginDir,
    directory,
    ...(commit ? { commit } : {}),
    ...(isSymlink(pluginDir) ? { linked: true } : {}),
    ...(plugin?.targets ? { targets: plugin.targets } : {}),
  };

  if (!plugin) {
    return { ...base, error: "Plugin did not export a valid GloomPlugin." };
  }

  // Skip compiling something the desktop cannot run anyway; the marketplace
  // still lists it, explaining why it is inert.
  if (plugin.targets && !plugin.targets.includes("desktop")) {
    return { ...base, unsupportedTarget: "desktop" };
  }

  try {
    const mtimeMs = await newestMtime(pluginDir);
    const cached = options.fresh ? undefined : bundleCache.get(pluginDir);
    if (cached && cached.mtimeMs === mtimeMs) {
      return { ...base, code: cached.code };
    }

    // The view is compiled for production, so its React only ships the
    // production JSX runtime. A bundle built from a process without
    // NODE_ENV set targets jsx-dev-runtime instead and fails on first
    // render with "jsxDEV is not a function".
    const outDir = pluginBundleCacheDir(getPluginCacheDir());
    const result = await bundleExternalPlugin(pluginDir, join(outDir, directory), {
      define: { "process.env.NODE_ENV": "\"production\"" },
    });
    const code = await Bun.file(result.outputPath).text();
    bundleCache.set(pluginDir, { mtimeMs, code });
    log.info(`Bundled ${plugin.id} (${Math.round(code.length / 1024)}KB, shared: ${result.shared.join(", ")})`);
    return { ...base, code };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Bundling ${plugin.id} failed: ${message}`);
    return { ...base, error: message };
  }
}

/**
 * Bundles used to be cached inside the plugins folder, where the CLI listed
 * `.cache` as an installed plugin and tried to `git pull` it. It is only a
 * cache, so the old copy is dropped rather than migrated.
 */
async function removeLegacyBundleCache(pluginsDir: string): Promise<void> {
  const legacy = join(pluginsDir, ".cache");
  if (!existsSync(legacy)) return;
  try {
    await rm(legacy, { recursive: true, force: true });
  } catch (error) {
    log.error(`Could not remove the legacy bundle cache: ${error}`);
  }
}

export async function collectExternalPluginBundles(): Promise<DesktopExternalPluginBundle[]> {
  const pluginsDir = getPluginsDir();
  if (!existsSync(pluginsDir)) return [];

  await removeLegacyBundleCache(pluginsDir);
  const bundles: DesktopExternalPluginBundle[] = [];

  // Links every folder before reading any: a plugin that imports a sibling
  // needs the sibling linked too, whichever of them is read first.
  for (const pluginDir of await listPluginDirectories(pluginsDir)) {
    const bundle = await bundlePluginDirectory(pluginsDir, basename(pluginDir));
    if (bundle) bundles.push(bundle);
  }

  return bundles;
}

/** One plugin, compiled fresh, so the view can activate what was just installed or updated. */
export async function bundleExternalPluginDirectory(directory: string): Promise<DesktopExternalPluginBundle | null> {
  const pluginsDir = getPluginsDir();
  if (!existsSync(join(pluginsDir, directory))) return null;
  return bundlePluginDirectory(pluginsDir, directory, { fresh: true });
}

/**
 * Runs git and bun on behalf of the desktop view, which cannot do so itself.
 * Errors are returned rather than thrown so the marketplace can show them
 * next to the plugin instead of surfacing an RPC failure.
 */
async function attempt(run: () => Promise<{ directory: string }>): Promise<DesktopPluginOperationResult> {
  try {
    const { directory } = await run();
    return { ok: true, directory };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function installExternalPlugin(ref: string, pin?: DesktopPluginPin): Promise<DesktopPluginOperationResult> {
  return attempt(async () => {
    const { installPlugin } = await import("../../../cli/commands/plugins");
    return installPlugin(ref, { quiet: true, pin });
  });
}

export function updateExternalPlugin(directory: string, pin?: DesktopPluginPin): Promise<DesktopPluginOperationResult> {
  return attempt(async () => {
    const { updatePlugin } = await import("../../../cli/commands/plugins");
    const result = await updatePlugin(directory, { quiet: true, pin });
    bundleCache.delete(result.path);
    return result;
  });
}

/** The view cannot run git, so the update check for unlisted plugins happens here. */
export async function readExternalPluginRemoteHeads(directories: readonly string[]): Promise<Record<string, string>> {
  const { readPluginRemoteHeads } = await import("../../../cli/commands/plugins");
  return readPluginRemoteHeads(directories);
}

export function removeExternalPlugin(directory: string): Promise<DesktopPluginOperationResult> {
  return attempt(async () => {
    const { removePlugin } = await import("../../../cli/commands/plugins");
    bundleCache.delete(join(getPluginsDir(), directory));
    await removePlugin(directory, { quiet: true });
    return { directory };
  });
}

/**
 * Registers a plugin in this process after startup.
 *
 * The view registers the same plugin for its panes and commands, but a
 * capability or broker call from the view is forwarded here, to the registry
 * built when the app launched. Without this step a plugin installed from the
 * marketplace would render its panes and fail on its first data request until
 * a relaunch. An update replaces the running registration; the module is
 * imported fresh so the new code is what registers.
 */
export async function activateExternalPlugin(
  registry: PluginRegistry,
  directory: string,
): Promise<DesktopPluginActivationResult> {
  const pluginDir = join(getPluginsDir(), directory);
  const loaded = await loadExternalPlugin(pluginDir, "desktop", { fresh: true });
  if (!loaded) return { ok: false, error: "The plugin has no entry file." };
  if (loaded.error) return { ok: false, error: loaded.error };
  if (loaded.unsupportedTarget) return { ok: false, error: `${loaded.plugin.name} does not run on the desktop.` };

  const pluginId = loaded.plugin.id;
  try {
    if (registry.allPlugins.has(pluginId)) registry.unregister(pluginId);
    await registry.register(loaded.plugin);
    log.info(`Activated ${pluginId} v${loaded.plugin.version ?? "?"} in the Bun process`);
    return { ok: true, pluginId, capabilityManifests: desktopRendererCapabilityManifests(registry.capabilities) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Activating ${pluginId} failed: ${message}`);
    return { ok: false, error: message };
  }
}

export function deactivateExternalPlugin(
  registry: PluginRegistry,
  pluginId: string,
): { capabilityManifests: ReturnType<typeof desktopRendererCapabilityManifests> } {
  if (registry.allPlugins.has(pluginId)) {
    try {
      registry.unregister(pluginId);
    } catch (error) {
      log.error(`Deactivating ${pluginId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { capabilityManifests: desktopRendererCapabilityManifests(registry.capabilities) };
}
