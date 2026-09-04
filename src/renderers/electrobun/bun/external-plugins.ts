import { readdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import type { DesktopExternalPluginBundle } from "../shared/protocol";
import { bundleExternalPlugin, pluginBundleCacheDir } from "../../../plugins/bundle";
import { linkHostPackages } from "../../../plugins/host-link";
import { getPluginCacheDir, getPluginsDir, isPluginDirectory, resolvePluginEntry } from "../../../plugins/loader";
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

async function readPluginMetadata(entryFile: string): Promise<GloomPlugin | null> {
  try {
    const mod = await import(entryFile);
    const plugin: GloomPlugin = mod.default ?? mod.plugin;
    return plugin?.id && plugin?.name ? plugin : null;
  } catch (error) {
    log.error(`Metadata read failed for ${entryFile}: ${error}`);
    return null;
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
  const outDir = pluginBundleCacheDir(getPluginCacheDir());
  const bundles: DesktopExternalPluginBundle[] = [];

  for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isPluginDirectory(entry.name)) continue;
    const pluginDir = join(pluginsDir, entry.name);

    const entryFile = await resolvePluginEntry(pluginDir);
    if (!entryFile) continue;

    linkHostPackages(pluginDir);

    const plugin = await readPluginMetadata(entryFile);
    const base = {
      id: plugin?.id ?? entry.name,
      name: plugin?.name ?? entry.name,
      version: plugin?.version ?? "0.0.0",
      path: pluginDir,
      ...(plugin?.targets ? { targets: plugin.targets } : {}),
    };

    if (!plugin) {
      bundles.push({ ...base, error: "Plugin did not export a valid GloomPlugin." });
      continue;
    }

    // Skip compiling something the desktop cannot run anyway; the marketplace
    // still lists it, explaining why it is inert.
    if (plugin.targets && !plugin.targets.includes("desktop")) {
      bundles.push({ ...base, error: `${plugin.name} does not support the desktop app.` });
      continue;
    }

    try {
      const mtimeMs = await newestMtime(pluginDir);
      const cached = bundleCache.get(pluginDir);
      if (cached && cached.mtimeMs === mtimeMs) {
        bundles.push({ ...base, code: cached.code });
        continue;
      }

      const result = await bundleExternalPlugin(pluginDir, join(outDir, entry.name));
      const code = await Bun.file(result.outputPath).text();
      bundleCache.set(pluginDir, { mtimeMs, code });
      log.info(`Bundled ${plugin.id} (${Math.round(code.length / 1024)}KB, shared: ${result.shared.join(", ")})`);
      bundles.push({ ...base, code });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Bundling ${plugin.id} failed: ${message}`);
      bundles.push({ ...base, error: message });
    }
  }

  return bundles;
}

/**
 * Installs a plugin on behalf of the desktop view, which cannot run git or bun
 * itself. Errors are returned rather than thrown so the marketplace can show
 * them next to the plugin instead of surfacing an RPC failure.
 *
 * The bundle cache is cleared so the next `plugins.listExternal` compiles the
 * newly installed plugin rather than serving a stale set.
 */
export async function installExternalPlugin(ref: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { installPlugin } = await import("../../../cli/commands/plugins");
    await installPlugin(ref, { quiet: true });
    bundleCache.clear();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
