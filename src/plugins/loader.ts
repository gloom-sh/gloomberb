import { readdir } from "fs/promises";
import { basename, join } from "path";
import { existsSync, lstatSync, readFileSync, statSync } from "fs";
import { getGloomberbHome } from "../data/config/home";
import type { GloomPlugin, PluginTarget } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { reportCrash } from "../telemetry/crash-reports";
import { checkPluginCompatibility, explainPluginLoadError, pluginSourceFiles } from "./compat";
import { linkHostPackages } from "./host-link";
import { pluginFromModule, pluginSupportsTarget } from "./plugin-export";

const loaderLog = debugLog.createLogger("plugin-loader");

const PLUGINS_DIR = join(getGloomberbHome(), "plugins");
/**
 * Host-owned scratch space for plugins, kept beside the plugins folder rather
 * than inside it so nothing the host writes can be mistaken for an install.
 */
const PLUGIN_CACHE_DIR = join(getGloomberbHome(), "plugin-cache");

export interface LoadedExternalPlugin {
  plugin: GloomPlugin;
  path: string;
  /** Folder name under the plugins directory; what `update` and `remove` address. */
  directory?: string;
  /** The checked-out git commit, when the install is a git checkout. */
  commit?: string;
  /** A symlink to a local checkout (`gloomberb plugin link`) rather than a clone. */
  linked?: boolean;
  error?: string;
  /**
   * The Gloomberb the checkout declares it needs, when this one is older. The
   * plugin was not imported and `error` says so.
   */
  needsGloomberb?: string;
  /** Set when the plugin loaded but does not support the running renderer. */
  unsupportedTarget?: PluginTarget;
  /** Loaded after startup in a way this session could not fully apply. */
  needsRestart?: boolean;
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

/**
 * The commit a plugin checkout is at, read from `.git` directly so startup does
 * not spawn one git process per plugin. Returns null for anything that is not
 * a git checkout (a hand-copied folder, or a dev symlink without history).
 */
export function readPluginCommit(pluginDir: string): string | null {
  const gitDir = join(pluginDir, ".git");
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head;
    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null;
    if (!ref) return null;
    const refPath = join(gitDir, ref);
    if (existsSync(refPath)) return readFileSync(refPath, "utf-8").trim() || null;
    const packed = join(gitDir, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf-8").split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && sha && /^[0-9a-f]{40}$/i.test(sha)) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

export interface LoadExternalPluginOptions {
  /**
   * Import the entry as a fresh module. Bun caches `import()` by URL, so a
   * plugin that was already evaluated in this process would otherwise come
   * back unchanged after `update`.
   */
  fresh?: boolean;
}

/**
 * The commit each plugin folder was first imported at in this process.
 *
 * A fresh import re-reads the entry file only. Bun keeps every other module
 * cached by path, so after an update a plugin split across files runs its new
 * entry against its old files, including one that failed to import, until
 * the process restarts.
 */
const importedCommits = new Map<string, string | null>();

/** Imported at another commit earlier in this process, with files besides the entry that Bun keeps. */
function hasStaleModules(pluginDir: string, commit: string | null): boolean {
  if (!importedCommits.has(pluginDir) || importedCommits.get(pluginDir) === commit) return false;
  try {
    return pluginSourceFiles(pluginDir).length > 1;
  } catch {
    return true;
  }
}

/** Loads one plugin directory. Never throws: a broken plugin comes back with `error` set. */
export async function loadExternalPlugin(
  pluginDir: string,
  target: PluginTarget = "cli",
  options: LoadExternalPluginOptions = {},
): Promise<LoadedExternalPlugin | null> {
  const directory = basename(pluginDir);
  const entryFile = await resolvePluginEntry(pluginDir);
  if (!entryFile) return null;

  // Repairs `gloomberb`/`react` links for plugins copied in by hand or left
  // behind by a `bun install` that pruned them.
  linkHostPackages(pluginDir);

  const commit = readPluginCommit(pluginDir);
  const linked = isSymlink(pluginDir);
  const placeholder = { id: directory, name: directory, version: "" } as GloomPlugin;
  const base = {
    path: pluginDir,
    directory,
    ...(commit ? { commit } : {}),
    ...(linked ? { linked: true } : {}),
  };

  // Not for a linked checkout: that is the author's working copy, usually
  // built against a Gloomberb run from source, which reports its last
  // release. `plugin doctor` still checks the range.
  const incompatible = linked ? null : checkPluginCompatibility(pluginDir);
  if (incompatible) {
    loaderLog.info(`Skipped ${directory}: ${incompatible.error}`);
    return {
      ...base,
      plugin: placeholder,
      error: incompatible.error,
      ...(incompatible.needsGloomberb ? { needsGloomberb: incompatible.needsGloomberb } : {}),
    };
  }

  const restart = hasStaleModules(pluginDir, commit) ? { needsRestart: true } : {};
  if (!importedCommits.has(pluginDir)) importedCommits.set(pluginDir, commit);

  try {
    const specifier = options.fresh ? `${entryFile}?reload=${Date.now()}` : entryFile;
    const plugin = pluginFromModule(await import(specifier));
    if (!plugin) {
      const error = "Plugin did not export a valid GloomPlugin (missing id or name).";
      reportCrash(error, { kind: "plugin", plugin: directory });
      return {
        ...base,
        ...restart,
        plugin: placeholder,
        error,
      };
    }
    if (!pluginSupportsTarget(plugin, target)) {
      loaderLog.info(`Skipped ${plugin.id}: does not support "${target}"`);
      return { ...base, ...restart, plugin, unsupportedTarget: target };
    }
    loaderLog.info(`Loaded external plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
    return { ...base, ...restart, plugin };
  } catch (err) {
    loaderLog.error(`Failed to load plugin from ${pluginDir}: ${err}`);
    reportCrash(err, { kind: "plugin", plugin: directory });
    return {
      ...base,
      ...restart,
      plugin: placeholder,
      error: explainPluginLoadError(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Every plugin folder under the plugins directory, linked to the host.
 *
 * Linking has to finish for all of them before any is imported. A plugin
 * that imports a sibling (Gateway imports Flex) pulls the sibling's files in
 * during its own import, and those files resolve `gloomberb/*` from the
 * sibling's folder. If that folder is linked only when its own turn comes,
 * the lookup fails, and Bun caches the miss, so linking it afterwards does
 * not repair the sibling either. Which plugin comes first is up to readdir.
 */
export async function listPluginDirectories(pluginsDir: string = PLUGINS_DIR): Promise<string[]> {
  if (!existsSync(pluginsDir)) return [];
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!isPluginDirectory(entry.name)) continue;
    const pluginDir = join(pluginsDir, entry.name);
    if (isDirectoryOrLink(entry, pluginDir)) dirs.push(pluginDir);
  }
  dirs.sort();
  for (const pluginDir of dirs) linkHostPackages(pluginDir);
  return dirs;
}

export async function loadExternalPlugins(target: PluginTarget = "cli"): Promise<LoadedExternalPlugin[]> {
  const results: LoadedExternalPlugin[] = [];
  for (const pluginDir of await listPluginDirectories()) {
    const loaded = await loadExternalPlugin(pluginDir, target);
    if (loaded) results.push(loaded);
  }
  return results;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A linked plugin (`gloomberb plugin link`) is a symlink, which `readdir` does not report as a directory. */
export function isDirectoryOrLink(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }, path: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
