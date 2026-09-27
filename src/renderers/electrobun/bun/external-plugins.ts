import { readdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { basename, join } from "path";

import type {
  DesktopExternalPluginBundle,
  DesktopPluginActivationResult,
} from "../shared/protocol";
import { bundleExternalPlugin, pluginBundleCacheDir } from "../../../plugins/bundle";
import {
  getPluginCacheDir,
  getPluginsDir,
  listPluginDirectories,
  loadExternalPlugin,
} from "../../../plugins/loader";
import { createNodePluginManager } from "../../../plugins/manager-node";
import type { PluginRegistry } from "../../../plugins/registry";
import { desktopRendererCapabilityManifests } from "./desktop/initialization";
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

async function bundlePluginDirectory(
  pluginDir: string,
  options: { fresh?: boolean } = {},
): Promise<DesktopExternalPluginBundle | null> {
  // The same load the terminal does, so the metadata, the commit and whether
  // the plugin runs on the desktop at all are decided in one place.
  const loaded = await loadExternalPlugin(pluginDir, "desktop", options);
  if (!loaded) return null;

  const { plugin } = loaded;
  const directory = basename(pluginDir);
  const base = {
    id: plugin.id,
    name: plugin.name,
    // Empty rather than a made-up number when the plugin could not be read.
    version: plugin.version ?? "",
    path: pluginDir,
    directory,
    ...(loaded.commit ? { commit: loaded.commit } : {}),
    ...(loaded.linked ? { linked: true } : {}),
    ...(plugin.targets ? { targets: plugin.targets } : {}),
  };

  // The view could run a fresh bundle, but data calls land here, on the
  // modules this process imported first; both halves wait for the restart.
  if (loaded.needsRestart) return { ...base, needsRestart: true };

  if (loaded.error) {
    return { ...base, error: loaded.error, ...(loaded.needsGloomberb ? { needsGloomberb: loaded.needsGloomberb } : {}) };
  }

  // Skip compiling something the desktop cannot run anyway; the marketplace
  // still lists it, explaining why it is inert.
  if (loaded.unsupportedTarget) return { ...base, unsupportedTarget: "desktop" };

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
    const bundle = await bundlePluginDirectory(pluginDir);
    if (bundle) bundles.push(bundle);
  }

  return bundles;
}

/** One plugin, compiled fresh, so the view can activate what was just installed or updated. */
export function bundleExternalPluginDirectory(directory: string): Promise<DesktopExternalPluginBundle | null> {
  return bundlePluginDirectory(join(getPluginsDir(), directory), { fresh: true });
}

/**
 * Runs git and bun on behalf of the desktop view, which cannot do so itself,
 * and drops the cached bundle of whatever changed so the next compile reads
 * the new files.
 */
export const desktopPluginManager = createNodePluginManager("desktop", {
  onChanged: (pluginDir) => bundleCache.delete(pluginDir),
});

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
