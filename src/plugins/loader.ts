import { readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type { GloomPlugin, PluginTarget } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { linkHostPackages } from "./host-link";

const loaderLog = debugLog.createLogger("plugin-loader");

const PLUGINS_DIR = join(process.env.HOME || homedir(), ".gloomberb", "plugins");
/**
 * Host-owned scratch space for plugins, kept beside the plugins folder rather
 * than inside it so nothing the host writes can be mistaken for an install.
 */
const PLUGIN_CACHE_DIR = join(process.env.HOME || homedir(), ".gloomberb", "plugin-cache");

export interface LoadedExternalPlugin {
  plugin: GloomPlugin;
  path: string;
  error?: string;
  /** Set when the plugin loaded but does not support the running renderer. */
  unsupportedTarget?: PluginTarget;
}

export function getPluginsDir(): string {
  return PLUGINS_DIR;
}

export function getPluginCacheDir(): string {
  return PLUGIN_CACHE_DIR;
}

/**
 * Whether a directory inside the plugins folder is a plugin at all.
 *
 * Dot-directories are bookkeeping, not plugins: the desktop bundle cache used
 * to be written to `plugins/.cache`, and it showed up in `gloomberb plugins`
 * as an installed plugin and in `gloomberb update` as a repo to pull. The
 * cache has moved out, but old installs still have that directory, so this
 * stays as the single rule every reader shares.
 */
export function isPluginDirectory(name: string): boolean {
  return !name.startsWith(".");
}

async function readPluginPackageField(pluginDir: string, field: string): Promise<string | null> {
  const pkgPath = join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(await Bun.file(pkgPath).text());
    const value = pkg[field];
    if (typeof value !== "string" || !value) return null;
    const resolved = join(pluginDir, value);
    return existsSync(resolved) ? resolved : null;
  } catch {
    // Malformed package.json falls through to the index candidates.
    return null;
  }
}

function resolveIndexCandidate(pluginDir: string, prefix: string): string | null {
  for (const extension of ["ts", "tsx", "js"]) {
    const path = join(pluginDir, `${prefix}.${extension}`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Resolves a plugin directory's entry file the way `bun install` would. */
export async function resolvePluginEntry(pluginDir: string): Promise<string | null> {
  return await readPluginPackageField(pluginDir, "main")
    ?? resolveIndexCandidate(pluginDir, "index");
}

/**
 * Resolves the entry to compile for a browser renderer, preferring the standard
 * `browser` field and falling back to the native entry.
 *
 * A plugin that touches sockets, DNS, or the filesystem cannot be compiled for
 * the desktop view: Bun's browser target rejects `node:*` imports even behind a
 * dynamic import. The app solves this for its own build with private alias
 * rules that swap in stubs, which a plugin in its own repository cannot reach.
 * The `browser` field is that same escape hatch, published: ship a
 * renderer-safe module with the same plugin metadata and let the native half
 * run in the Bun process, where the desktop calls it over RPC anyway.
 */
export async function resolvePluginBrowserEntry(pluginDir: string): Promise<string | null> {
  return await readPluginPackageField(pluginDir, "browser")
    ?? resolveIndexCandidate(pluginDir, "index.browser")
    ?? await resolvePluginEntry(pluginDir);
}

export function pluginSupportsTarget(plugin: GloomPlugin, target: PluginTarget): boolean {
  // No declaration means "everywhere"; the registry fills this in for listed plugins.
  return !plugin.targets || plugin.targets.length === 0 || plugin.targets.includes(target);
}

export async function loadExternalPlugins(target: PluginTarget = "cli"): Promise<LoadedExternalPlugin[]> {
  if (!existsSync(PLUGINS_DIR)) return [];

  const results: LoadedExternalPlugin[] = [];
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !isPluginDirectory(entry.name)) continue;
    const pluginDir = join(PLUGINS_DIR, entry.name);

    const entryFile = await resolvePluginEntry(pluginDir);
    if (!entryFile) continue;

    // Repairs `gloomberb`/`react` links for plugins copied in by hand or left
    // behind by a `bun install` that pruned them.
    linkHostPackages(pluginDir);

    try {
      const mod = await import(entryFile);
      const plugin: GloomPlugin = mod.default ?? mod.plugin;
      if (plugin && plugin.id && plugin.name) {
        if (!pluginSupportsTarget(plugin, target)) {
          loaderLog.info(`Skipped ${plugin.id}: does not support "${target}"`);
          results.push({ plugin, path: pluginDir, unsupportedTarget: target });
          continue;
        }
        loaderLog.info(`Loaded external plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
        results.push({ plugin, path: pluginDir });
      }
    } catch (err) {
      loaderLog.error(`Failed to load plugin from ${pluginDir}: ${err}`);
      results.push({
        plugin: { id: entry.name, name: entry.name, version: "0.0.0" } as GloomPlugin,
        path: pluginDir,
        error: String(err),
      });
    }
  }

  return results;
}
