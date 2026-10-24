import { logFailure } from "../utils/log-failure";
import { readdir } from "fs/promises";
import { basename, dirname, join } from "path";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { getGloomberbDirs } from "../data/config/home";
import type { GloomPlugin, PluginTarget } from "../types/plugin";
import { debugLog } from "../utils/debug-log";
import { reportCrash } from "../telemetry/crash-reports";
import { VERSION } from "../version";
import { findAbsorbedPlugin, type AbsorbedPlugin } from "./absorbed";
import { checkPluginCompatibility, explainPluginLoadError, findMissingHostExport, pluginSourceFiles, readPluginManifest } from "./compat";
import {
  describeDependencyInstalls,
  installPluginDependencies,
  missingPluginDependencies,
  settleDependencyInstalls,
} from "./dependencies";
import { declaredPeerPlugins, describePeerLink, isLinkedPeerModule, linkHostPackages, relinkPeerPlugin } from "./host-link";
import { refreshResolverFolders, rekeyedEntry, withoutRetryQuery } from "./peer-retry";
import { pluginDirectoryNames } from "./plugin-names";
import { pluginFromModule, pluginSupportsTarget } from "./plugin-export";

const loaderLog = debugLog.createLogger("plugin-loader");

const GLOOMBERB_DIRS = getGloomberbDirs();
const PLUGINS_DIR = GLOOMBERB_DIRS.plugins;
/**
 * Host-owned scratch space for plugins, kept outside the plugins folder so
 * nothing the host writes can be mistaken for an install.
 */
const PLUGIN_CACHE_DIR = GLOOMBERB_DIRS.pluginCache;

export interface LoadedExternalPlugin {
  plugin: GloomPlugin;
  path: string;
  /** Folder name under the plugins directory; what `update` and `remove` address. */
  directory?: string;
  /** The checked-out git commit, when the install is a git checkout. */
  commit?: string;
  /** `owner/repo` of the checkout's GitHub origin; usage counts trust only gloom-sh's. */
  repo?: string;
  /** A symlink to a local checkout (`gloom plugin link`) rather than a clone. */
  linked?: boolean;
  /**
   * The plugin's logo as a `data:` URL (plugin-icon.ts), for the desktop and
   * the web to draw beside what it contributes, such as its broker. The
   * terminal draws no images and leaves it unread.
   */
  icon?: string;
  error?: string;
  /**
   * The Gloomberb the checkout declares it needs, when this one is older. The
   * plugin was not imported and `error` says so.
   */
  needsGloomberb?: string;
  /** Set when the plugin loaded but does not support the running renderer. */
  unsupportedTarget?: PluginTarget;
  /**
   * Loaded in a way this session cannot fully apply: new files under modules
   * it already imported, or an import Bun failed before a sibling plugin was
   * linked. Never registered; the next launch loads it.
   */
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
 * to be written to `plugins/.cache`, and it showed up in `gloom plugins`
 * as an installed plugin and in `gloom update` as a repo to pull. The
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
  } catch (error) {
    logFailure("plugin-loader", "Plugin entry metadata read failed")(error);
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

/** `owner/repo` of a checkout's GitHub origin, read from `.git/config` directly; null for anything else. */
function readPluginOriginRepo(pluginDir: string): string | null {
  try {
    const config = readFileSync(join(pluginDir, ".git", "config"), "utf-8");
    const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1] ?? "";
    const url = /^\s*url\s*=\s*(\S+)/m.exec(origin)?.[1] ?? "";
    const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    // Intentional ignore: Hand-copied plugins may have no git origin metadata.
    return null;
  }
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
    // Intentional ignore: Hand-copied plugins and history-free links may have no commit metadata.
    return null;
  }
}

/**
 * The built-in a plugin folder is a leftover copy of, by its folder name or
 * the id its gloom.json declares, or null. Reads gloom.json only, so it is
 * safe to ask before anything in the folder is linked or imported.
 */
export function findAbsorbedCheckout(pluginDir: string): AbsorbedPlugin | null {
  return findAbsorbedPlugin({ directory: basename(pluginDir), id: readPluginManifest(pluginDir).id });
}

function skipsAbsorbedCheckout(pluginDir: string, absorbed: AbsorbedPlugin | null = findAbsorbedCheckout(pluginDir)): boolean {
  if (!absorbed) return false;
  loaderLog.debug(`Skipped ${basename(pluginDir)}: ${absorbed.name} is built into Gloom now`);
  return true;
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

/**
 * Folders whose last import in this process failed on a host export the
 * running Gloomberb does not have: a checkout older (or newer) than the host.
 * The automatic updater looks for a newer compatible version of these first.
 */
const missingHostExportFailures = new Set<string>();

/** Plugin folders, by name, whose last load failed on a missing host export. */
export function pluginsMissingHostExports(): string[] {
  return [...missingHostExportFailures].sort();
}

/**
 * Link failures of a new entry against files this process kept from the old
 * commit: an export the old file lacks, or a package that was not there.
 */
const STALE_LINK_FAILURE = /Export named '[^']+' not found in module|No matching export in "[^"]+" for import|Cannot find (?:module|package) '/;

/** Bun's wording when an import does not resolve, from a native import. */
const UNRESOLVED_MODULE = /Cannot find (?:module|package) '([^']+)'/;

/**
 * The specifier an import failed to resolve. Bun puts it on the error as
 * `specifier`; the message is only a fallback, because from Bun 1.4 it names
 * the package alone ("Cannot find package 'peer' imported from …" for
 * `peer/bridge`), and the subpath decides whether the peer has the file.
 */
export function unresolvedSpecifier(err: unknown, message: string): string | undefined {
  const specifier = (err as { specifier?: unknown } | null)?.specifier;
  if (typeof specifier === "string" && specifier) return specifier;
  return UNRESOLVED_MODULE.exec(message)?.[1];
}

/** Imported at another commit earlier in this process, with files besides the entry that Bun keeps. */
function hasStaleModules(pluginDir: string, commit: string | null): boolean {
  if (!importedCommits.has(pluginDir) || importedCommits.get(pluginDir) === commit) return false;
  try {
    return pluginSourceFiles(pluginDir).length > 1;
  } catch (error) {
    logFailure("plugin-loader", "Plugin source inspection failed")(error);
    return true;
  }
}

/**
 * The entry a plugin was imported from on a retry, by plugin folder. A later
 * load of the same plugin that is not fresh imports it from there again, so
 * it gets the modules that loaded instead of the failed ones.
 */
const retriedEntries = new Map<string, string>();

/** Plugin folders whose recovery this process already reported; once is enough to explain it. */
const reportedRecoveries = new Set<string>();

/** Loads running now, which a crash report counts: two at once share the links they rewrite. */
let loadsInFlight = 0;

/**
 * Whether this process is the first to load plugins since this version was
 * installed, null until the first full load records it. Read from a marker
 * in the plugin cache, which the first startup load of a new version writes.
 */
let firstLaunchOfVersion: boolean | null = null;

function recordLaunchedVersion(): void {
  if (firstLaunchOfVersion !== null) return;
  const marker = join(PLUGIN_CACHE_DIR, "loaded-version");
  try {
    const previous = existsSync(marker) ? readFileSync(marker, "utf-8").trim() : null;
    firstLaunchOfVersion = previous !== VERSION;
    if (firstLaunchOfVersion) {
      mkdirSync(PLUGIN_CACHE_DIR, { recursive: true });
      writeFileSync(marker, VERSION);
    }
  } catch (error) {
    logFailure("plugin-loader", "Recording the loaded version failed")(error);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The sibling plugin a failed import named, when the plugin declares it as a peer. */
function failedPeer(pluginDir: string, specifier: string | undefined): string | null {
  if (!specifier) return null;
  return declaredPeerPlugins(pluginDir).find((peer) => specifier === peer || specifier.startsWith(`${peer}/`)) ?? null;
}

/**
 * The state of the link to `peer` and around it, for the crash report of an
 * import that failed on it: whether the sibling's folder is there, what the
 * link is and where it points, whether the retry rewrote it, how often this
 * process wrote it before, which `bun install` runs this process made, how
 * many loads ran at once, and whether this is the first launch of the version.
 */
function describePeerFailure(pluginDir: string, peer: string, relinked: string, retry: string): string {
  const link = describePeerLink(pluginDir, peer);
  const now = Date.now();
  const installs = describeDependencyInstalls(now);
  const fields = [
    `retry=${retry}`,
    `peer=${peer}`,
    `dir=${link.directory ?? "missing"}`,
    `link=${link.link}${link.target ? `->${link.target}` : ""}${link.linked ? "" : "(not-resolving)"}`,
    `relinked=${relinked}`,
    `link-writes=${link.writes}${link.lastWriteAt ? `@${((now - link.lastWriteAt) / 1000).toFixed(1)}s` : ""}`,
    ...(link.lastError ? [`link-error=${link.lastError}`] : []),
    `installs=${installs.length > 0 ? installs.slice(0, 4).join(",") : "none"}`,
    `loads=${loadsInFlight}`,
    `first-launch=${firstLaunchOfVersion === null ? "unknown" : firstLaunchOfVersion ? "yes" : "no"}`,
    ...(typeof Bun !== "undefined" ? [`bun=${Bun.version}`] : []),
  ];
  return fields.join(" ");
}

type PeerRetry =
  | { module: unknown; detail: string }
  | { error: unknown; detail: string };

/**
 * The import that failed on `peer`, once more after linking the sibling
 * again: past Bun's cached view of the plugin's folders and under new module
 * keys (see peer-retry.ts), so it really resolves the sibling again rather
 * than replaying the failure.
 */
async function retryPeerImport(pluginDir: string, entryFile: string, peer: string): Promise<PeerRetry> {
  // A `bun install` still running in the plugin or the sibling prunes the
  // link it is about to need.
  const peerDirs = pluginDirectoryNames(peer).map((name) => join(dirname(pluginDir), name));
  await settleDependencyInstalls([pluginDir, ...peerDirs], 15_000);
  // Windows refuses a new junction where one is still being deleted until
  // every handle on the old one closes; that passes in moments.
  const attempts = [relinkPeerPlugin(pluginDir, peer)];
  for (const delayMs of [250, 1_000]) {
    if (!attempts.at(-1)!.startsWith("failed")) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempts.push(relinkPeerPlugin(pluginDir, peer));
  }
  const relinked = attempts.join(",");
  // An install that finished during the wait pruned `gloomberb` and `react`
  // as well. After the sibling's own relink, so `relinked` says what that did.
  linkHostPackages(pluginDir);
  refreshResolverFolders(pluginDir, [peer]);
  const specifier = rekeyedEntry(entryFile, pluginDir);
  if (!specifier) {
    return { error: new Error("This process cannot import a plugin again."), detail: describePeerFailure(pluginDir, peer, relinked, "unavailable") };
  }
  try {
    const module = await import(specifier);
    retriedEntries.set(pluginDir, specifier);
    return { module, detail: describePeerFailure(pluginDir, peer, relinked, "loaded") };
  } catch (error) {
    return { error, detail: describePeerFailure(pluginDir, peer, relinked, "failed") };
  }
}

/**
 * Loads one plugin directory. Never throws: a broken plugin comes back with
 * `error` set. Null for a folder that is not a plugin, and for a leftover
 * checkout of a plugin that is built in now, which would only fail on the
 * built-in's id.
 */
export async function loadExternalPlugin(
  pluginDir: string,
  target: PluginTarget = "cli",
  options: LoadExternalPluginOptions = {},
): Promise<LoadedExternalPlugin | null> {
  loadsInFlight += 1;
  try {
    return await loadPluginDirectory(pluginDir, target, options);
  } finally {
    loadsInFlight -= 1;
  }
}

async function loadPluginDirectory(
  pluginDir: string,
  target: PluginTarget,
  options: LoadExternalPluginOptions,
): Promise<LoadedExternalPlugin | null> {
  const directory = basename(pluginDir);
  missingHostExportFailures.delete(directory);
  if (skipsAbsorbedCheckout(pluginDir)) return null;
  const entryFile = await resolvePluginEntry(pluginDir);
  if (!entryFile) return null;

  // Repairs `gloomberb`/`react` links for plugins copied in by hand or left
  // behind by a `bun install` that pruned them.
  linkHostPackages(pluginDir);

  const commit = readPluginCommit(pluginDir);
  const repo = readPluginOriginRepo(pluginDir);
  const linked = isSymlink(pluginDir);
  const placeholder = { id: directory, name: directory, version: "" } as GloomPlugin;
  const base = {
    path: pluginDir,
    directory,
    ...(commit ? { commit } : {}),
    ...(repo ? { repo } : {}),
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

  // A plugin installed where `bun` was not on PATH never got its packages.
  // Not for a linked checkout: that is the author's to install.
  if (!linked) {
    const missing = missingPluginDependencies(pluginDir);
    if (missing.length > 0) {
      loaderLog.info(`Installing ${directory}'s missing dependencies: ${missing.join(", ")}`);
      await installPluginDependencies(pluginDir);
    }
  }

  const restart = hasStaleModules(pluginDir, commit) ? { needsRestart: true } : {};
  if (!importedCommits.has(pluginDir)) importedCommits.set(pluginDir, commit);

  const failed = (err: unknown, retry?: Extract<PeerRetry, { error: unknown }>): LoadedExternalPlugin => {
    const message = errorMessage(err);
    let detail: string | undefined;
    if (retry) {
      // As plain text: escaping would double a Windows path's backslashes,
      // and the home folder would no longer be recognized to remove.
      const retryMessage = withoutRetryQuery(errorMessage(retry.error));
      detail = retryMessage === message ? retry.detail : `${retry.detail} retry-error=${retryMessage.slice(0, 200)}`;
      // The sibling is installed and linked, and a second import that
      // looked again still failed. A new process imports everything fresh,
      // so the plugin asks for a restart, and the report says why it got here.
      const unresolved = unresolvedSpecifier(err, message);
      if (unresolved && isLinkedPeerModule(pluginDir, unresolved)) {
        loaderLog.info(`${directory} loads after a restart: ${message} [${detail}]`);
        reportCrash(err, { kind: "plugin", plugin: directory, detail });
        return { ...base, plugin: placeholder, needsRestart: true };
      }
    }
    // An update that links against modules this process imported at the old
    // commit, which Bun keeps until a restart. The row already asks for one,
    // and the next launch imports everything fresh; a plugin that is really
    // broken fails there, and is reported there. A host export the running
    // Gloomberb lacks is a different failure and stays one.
    if (restart.needsRestart && !findMissingHostExport(message) && STALE_LINK_FAILURE.test(message)) {
      loaderLog.info(`${directory} loads after a restart: ${message}`);
      return { ...base, plugin: placeholder, needsRestart: true };
    }
    loaderLog.error(`Failed to load plugin from ${pluginDir}: ${err}${detail ? ` [${detail}]` : ""}`);
    reportCrash(err, { kind: "plugin", plugin: directory, ...(detail ? { detail } : {}) });
    if (findMissingHostExport(message)) missingHostExportFailures.add(directory);
    return {
      ...base,
      ...restart,
      plugin: placeholder,
      error: explainPluginLoadError(message),
    };
  };

  let module: unknown;
  try {
    const retried = options.fresh ? undefined : retriedEntries.get(pluginDir);
    module = await import(retried ?? (options.fresh ? `${entryFile}?reload=${Date.now()}` : entryFile));
  } catch (err) {
    // A sibling plugin it imports that did not resolve: not linked yet, or
    // its link was being rewritten. Bun keeps that failure for the process,
    // so the plugin is linked and imported again in a way that looks again.
    const peer = failedPeer(pluginDir, unresolvedSpecifier(err, errorMessage(err)));
    if (!peer) return failed(err);
    const retry = await retryPeerImport(pluginDir, entryFile, peer);
    if ("error" in retry) return failed(err, retry);
    // Loaded, but the failure it recovered from is still a bug somewhere:
    // the report carries the link state that explains it.
    loaderLog.info(`Loaded ${directory} on a second import: ${errorMessage(err)} [${retry.detail}]`);
    if (!reportedRecoveries.has(pluginDir)) {
      reportedRecoveries.add(pluginDir);
      reportCrash(err, { kind: "plugin", plugin: directory, detail: retry.detail });
    }
    module = retry.module;
  }

  try {
    const plugin = pluginFromModule(module);
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
    // A copy without a gloom.json, in a folder of another name.
    if (skipsAbsorbedCheckout(pluginDir, findAbsorbedPlugin({ id: plugin.id }))) return null;
    if (!pluginSupportsTarget(plugin, target)) {
      loaderLog.info(`Skipped ${plugin.id}: does not support "${target}"`);
      return { ...base, ...restart, plugin, unsupportedTarget: target };
    }
    loaderLog.info(`Loaded external plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
    return { ...base, ...restart, plugin };
  } catch (err) {
    return failed(err);
  }
}

/**
 * Every plugin folder under the plugins directory, linked to the host. A
 * leftover checkout of a plugin that is built in now is left out, and left
 * as it is.
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
    if (isDirectoryOrLink(entry, pluginDir) && !skipsAbsorbedCheckout(pluginDir)) dirs.push(pluginDir);
  }
  dirs.sort();
  for (const pluginDir of dirs) linkHostPackages(pluginDir);
  return dirs;
}

export async function loadExternalPlugins(target: PluginTarget = "cli"): Promise<LoadedExternalPlugin[]> {
  recordLaunchedVersion();
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
    // Intentional ignore: A removed path is not a linked checkout; the loader handles its missing entry.
    return false;
  }
}

/** A linked plugin (`gloom plugin link`) is a symlink, which `readdir` does not report as a directory. */
export function isDirectoryOrLink(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }, path: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    // Intentional ignore: Dangling plugin symlinks are excluded from the installed directory list.
    return false;
  }
}
