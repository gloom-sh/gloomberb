import { logFailure } from "../utils/log-failure";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, type Stats } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";

import { installPluginHostResolver } from "./host-resolver";
import { isPluginPackageName, pluginDirectoryNames } from "./plugin-names";

/**
 * External plugins live in `<plugins folder>/<name>/`, outside any
 * `node_modules` chain that could reach the running Gloomberb install. Left
 * alone, `import { Box } from "gloomberb/ui"` does not resolve, and a plugin
 * that lists `react` as a real dependency gets its *own* copy — two React
 * instances in one process, which throws on the first hook.
 *
 * So the host links itself and its React into each plugin's `node_modules`.
 * Plugins declare both as peer dependencies and never install them. This keeps
 * one module instance per process and makes plugin imports resolve exactly the
 * way they do for first-party code.
 *
 * Links are rebuilt after every install and update, because `bun install`
 * prunes entries it does not know about, and repaired at load time so a plugin
 * copied in by hand still works.
 *
 * A compiled or packaged host has no package directory to link to. It serves
 * the same modules from inside the process instead (see host-resolver.ts),
 * and this reports that as `provider: "process"` rather than as an error.
 */

// No react-dom: plugins are renderer-neutral (see SHARED_SPECIFIERS in
// host-modules.ts), so one that imports it should fail to resolve.
const LINKED_PACKAGES = ["gloomberb", "react"] as const;

let cachedHostRoot: string | null | undefined;

/**
 * Walks up from this module to the directory holding the `gloomberb` package.json.
 * @knipignore Also imported by the script host-resolver.test.ts compiles and runs.
 */
export function findHostPackageRoot(startDir: string = import.meta.dir): string | null {
  if (cachedHostRoot !== undefined && startDir === import.meta.dir) return cachedHostRoot;
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
        if (pkg.name === "gloomberb") {
          if (startDir === import.meta.dir) cachedHostRoot = dir;
          return dir;
        }
      } catch {
        // Intentional ignore: A candidate parent need not be the host; continue searching its ancestors.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (startDir === import.meta.dir) cachedHostRoot = null;
  return null;
}

let hostPublicModuleMap: Map<string, string> | null = null;

/**
 * The host's public modules, `gloomberb/ui` to the file it names, read from
 * the export map in the host's package.json. Empty for a packaged host: it
 * has no package on disk and serves the same specifiers from the process.
 */
export function hostPublicModules(): ReadonlyMap<string, string> {
  if (hostPublicModuleMap) return hostPublicModuleMap;
  const modules = new Map<string, string>();
  const root = findHostPackageRoot();
  if (root) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        exports?: Record<string, unknown>;
      };
      for (const [key, target] of Object.entries(pkg.exports ?? {})) {
        if (typeof target !== "string" || !key.startsWith(".")) continue;
        modules.set(key === "." ? "gloomberb" : `gloomberb/${key.slice(2)}`, join(root, target));
      }
    } catch (error) {
      logFailure("plugin-host-link", "Host export map read failed")(error);
      // An unreadable host package.json leaves the map empty, and callers fall
      // back to whatever resolution they would do without it.
    }
  }
  hostPublicModuleMap = modules;
  return modules;
}

function linkTarget(hostRoot: string, pkg: string): string | null {
  if (pkg === "gloomberb") return hostRoot;
  const candidate = join(hostRoot, "node_modules", pkg);
  if (existsSync(candidate)) return candidate;
  // A global install hoists dependencies beside the package rather than
  // inside it (`bun add -g` keeps one flat node_modules), so `react` is found
  // the way the host itself resolves it.
  try {
    return dirname(Bun.resolveSync(`${pkg}/package.json`, hostRoot));
  } catch (error) {
    logFailure("plugin-host-link", "Host runtime package resolution failed")(error);
    return null;
  }
}

/**
 * True when `path` is already a link pointing at `target`. Compared by real
 * path, since Windows spells a junction's target its own way, and failing
 * that by the folder's identity: one folder can still come back under two
 * spellings (a short 8.3 name, another case). A link that is right must be
 * left alone; rewriting it leaves a moment in which it is missing.
 */
function alreadyLinked(path: string, target: string): boolean {
  try {
    if (!isLink(path, lstatSync(path))) return false;
    const linked = realpathSync(path);
    const wanted = realpathSync(target);
    if (process.platform === "win32" ? linked.toLowerCase() === wanted.toLowerCase() : linked === wanted) return true;
    const a = statSync(path, { bigint: true });
    const b = statSync(target, { bigint: true });
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    // Intentional ignore: A missing or stale link is recreated by ensureDirLink.
    return false;
  }
}

/** A symlink or a junction. A directory whose real path is somewhere else is
 * treated as a link too, so a recursive delete never walks into its target. */
function isLink(path: string, stats: Stats): boolean {
  if (stats.isSymbolicLink()) return true;
  return stats.isDirectory() && realpathSync(path) !== join(realpathSync(dirname(path)), basename(path));
}

/**
 * Links this process wrote, and the last one it failed to write, by link
 * path. A crash report about a sibling plugin that did not resolve says
 * whether its link was rewritten just before, or could not be.
 */
const linkWrites = new Map<string, { count: number; at: number }>();
const linkFailures = new Map<string, { code: string; at: number }>();

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : error instanceof Error ? error.name : "Error";
}

/**
 * Makes `linkPath` a directory symlink to `target`, replacing whatever is
 * there. A real directory means `bun install` fetched a second copy; replacing
 * it is the whole point, otherwise the plugin runs against a duplicate React.
 * Throws when the link cannot be made. Returns whether it wrote one.
 */
function ensureDirLink(linkPath: string, target: string): boolean {
  if (alreadyLinked(linkPath, target)) return false;
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    const existing = lstatSync(linkPath, { throwIfNoEntry: false });
    if (existing && isLink(linkPath, existing)) unlinkSync(linkPath);
    else if (existing) rmSync(linkPath, { recursive: true, force: true });
    // A directory symlink on Windows needs Developer Mode or admin rights, and
    // without them every external plugin lost `gloomberb` and `react`. A
    // junction needs neither; other platforms ignore the type.
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    linkFailures.set(linkPath, { code: errorCode(error), at: Date.now() });
    throw error;
  }
  linkWrites.set(linkPath, { count: (linkWrites.get(linkPath)?.count ?? 0) + 1, at: Date.now() });
  return true;
}

/**
 * The sibling plugins a plugin declares as peer dependencies and that are
 * installed, by package name, with the folder each one is installed in. The
 * automatic updater orders updates by the same answer the links are made from.
 */
/**
 * Sibling plugins a plugin declares as peer dependencies that are not
 * installed under either name. IBKR Gateway, for one, imports the Interactive
 * Brokers plugin and cannot load without it.
 */
export function missingPeerPlugins(pluginDir: string, pluginsDir: string = dirname(pluginDir)): string[] {
  return declaredPeerPlugins(pluginDir)
    .filter((peer) => !pluginDirectoryNames(peer).some((name) => existsSync(join(pluginsDir, name))));
}

/** The sibling plugins a plugin declares as peer dependencies, by package name. */
export function declaredPeerPlugins(pluginDir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
    return Object.keys(pkg.peerDependencies ?? {}).filter(isPluginPackageName);
  } catch {
    // Intentional ignore: Plugins may have no package manifest; loadExternalPlugin reports missing imports.
    return [];
  }
}

export function installedPeerPlugins(pluginDir: string, pluginsDir: string = dirname(pluginDir)): Array<{ peer: string; directory: string }> {
  const installed: Array<{ peer: string; directory: string }> = [];
  for (const peer of declaredPeerPlugins(pluginDir)) {
    // Declared by package name, installed under a directory named for the repo:
    // the two disagree while the plugin is mid-rename.
    const directory = pluginDirectoryNames(peer).find((name) => existsSync(join(pluginsDir, name)));
    if (directory) installed.push({ peer, directory });
  }
  return installed;
}

/**
 * What is at a plugin's link to a sibling plugin, for a crash report about an
 * import of the sibling that did not resolve. Paths are named relative to the
 * plugins folder, never in full.
 */
export interface PeerLinkState {
  /** The sibling's folder under the plugins folder, null when it is not installed. */
  directory: string | null;
  link: "missing" | "junction" | "symlink" | "directory" | "file";
  /** Where the link points: a folder in the plugins folder, `elsewhere`, or `unreadable`. */
  target: string | null;
  /** The link resolves to the sibling's folder. */
  linked: boolean;
  /** Links this process wrote at that path, and when it last did. */
  writes: number;
  lastWriteAt?: number;
  /** The error of the last failed attempt to write it. */
  lastError?: string;
}

function describeTarget(linkPath: string, pluginsDir: string): string {
  try {
    const raw = readlinkSync(linkPath).replace(/^\\\\\?\\|^\\\?\?\\/, "");
    const target = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
    const inside = relative(pluginsDir, target);
    return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : "elsewhere";
  } catch {
    // Intentional ignore: a junction Bun cannot read back is reported as such.
    return "unreadable";
  }
}

export function describePeerLink(pluginDir: string, peer: string, pluginsDir: string = dirname(pluginDir)): PeerLinkState {
  const directory = pluginDirectoryNames(peer).find((name) => existsSync(join(pluginsDir, name))) ?? null;
  const linkPath = join(pluginDir, "node_modules", peer);
  const write = linkWrites.get(linkPath);
  const failure = linkFailures.get(linkPath);
  const base = {
    directory,
    writes: write?.count ?? 0,
    ...(write ? { lastWriteAt: write.at } : {}),
    ...(failure && (!write || failure.at >= write.at) ? { lastError: failure.code } : {}),
  };
  let stats: Stats | undefined;
  try {
    stats = lstatSync(linkPath, { throwIfNoEntry: false });
  } catch (error) {
    return { ...base, link: "missing", target: null, linked: false, lastError: errorCode(error) };
  }
  if (!stats) return { ...base, link: "missing", target: null, linked: false };
  let link: PeerLinkState["link"];
  try {
    link = isLink(linkPath, stats)
      ? (process.platform === "win32" ? "junction" : "symlink")
      : stats.isDirectory() ? "directory" : "file";
  } catch {
    // Intentional ignore: a link whose target is gone cannot be resolved to compare.
    link = stats.isSymbolicLink() ? (process.platform === "win32" ? "junction" : "symlink") : "file";
  }
  const isLinkType = link === "junction" || link === "symlink";
  return {
    ...base,
    link,
    target: isLinkType ? describeTarget(linkPath, pluginsDir) : null,
    linked: directory !== null && alreadyLinked(linkPath, join(pluginsDir, directory)),
  };
}

/**
 * Makes the link to one sibling plugin again, when it is not already right.
 * Returns `yes` when it wrote one, `no` when the link was right, `no-sibling`
 * when the sibling is not installed, and `failed:<code>` when the link could
 * not be written.
 */
export function relinkPeerPlugin(pluginDir: string, peer: string, pluginsDir: string = dirname(pluginDir)): string {
  const directory = pluginDirectoryNames(peer).find((name) => existsSync(join(pluginsDir, name)));
  if (!directory) return "no-sibling";
  try {
    return ensureDirLink(join(pluginDir, "node_modules", peer), join(pluginsDir, directory)) ? "yes" : "no";
  } catch (error) {
    logFailure("plugin-host-link", "Peer runtime link creation failed")(error);
    return `failed:${errorCode(error)}`;
  }
}

/** What an import without an extension can name: the file, one with an extension Bun tries, or a folder's index. */
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function packageMain(packageDir: string): string | null {
  try {
    const main = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")).main;
    return typeof main === "string" && main ? main : null;
  } catch {
    // Intentional ignore: A peer without a package main falls back to its index entry.
    return null;
  }
}

/**
 * Whether `specifier` (`gloom-ibkr/gateway-bridge`) names a file in a
 * sibling plugin that is installed and linked into `pluginDir` right now.
 * An import that failed to resolve one anyway ran before the link existed:
 * Bun keeps that answer for the rest of the process, so a restart fixes it.
 */
export function isLinkedPeerModule(pluginDir: string, specifier: string, pluginsDir: string = dirname(pluginDir)): boolean {
  const found = installedPeerPlugins(pluginDir, pluginsDir)
    .find(({ peer }) => specifier === peer || specifier.startsWith(`${peer}/`));
  if (!found) return false;
  const peerDir = join(pluginsDir, found.directory);
  if (!alreadyLinked(join(pluginDir, "node_modules", found.peer), peerDir)) return false;
  const subpath = specifier.slice(found.peer.length + 1) || packageMain(peerDir) || "index";
  return MODULE_SUFFIXES.some((suffix) => isFile(join(peerDir, subpath + suffix)));
}

/**
 * Links sibling plugins a plugin declares as peer dependencies.
 *
 * A plugin can legitimately extend another: IBKR Gateway builds on the Flex
 * plugin, which owns the broker id and the shared bridge. Those live in separate
 * install directories with no path between them, so the peer is linked the same
 * way the host is. A missing sibling is not an error here: the plugin reports it
 * at load, which is more useful than failing the install.
 */
function linkPeerPlugins(pluginDir: string, pluginsDir: string): string[] {
  const linked: string[] = [];
  for (const { peer, directory } of installedPeerPlugins(pluginDir, pluginsDir)) {
    try {
      ensureDirLink(join(pluginDir, "node_modules", peer), join(pluginsDir, directory));
      linked.push(peer);
    } catch (error) {
      logFailure("plugin-host-link", "Peer runtime link creation failed")(error);
    }
  }
  return linked;
}

export interface HostLinkResult {
  linked: string[];
  skipped: string[];
  /**
   * How the plugin reaches `gloomberb/*` and `react`: symlinks into a package
   * directory, or the host process answering the imports itself.
   */
  provider: "symlink" | "process";
  error?: string;
}

export interface HostLinkOptions {
  /**
   * Registers the in-process resolver when there is no package root. Tests
   * stub this: the real one changes how `react` resolves for the whole
   * process, which is the point in a packaged host and a hazard in a test run.
   */
  installResolver?: () => boolean;
}

/**
 * Points `<pluginDir>/node_modules/{gloomberb,react}` at the running install.
 * Safe to call repeatedly.
 */
export function linkHostPackages(
  pluginDir: string,
  hostRoot = findHostPackageRoot(),
  pluginsDir = dirname(pluginDir),
  options: HostLinkOptions = {},
): HostLinkResult {
  const linked: string[] = [];
  const skipped: string[] = [];

  if (!hostRoot) {
    // Peers still need their links: a sibling plugin is a directory the
    // resolver knows nothing about.
    const peers = linkPeerPlugins(pluginDir, pluginsDir);
    const installResolver = options.installResolver ?? installPluginHostResolver;
    if (installResolver()) {
      return { linked: peers, skipped: [...LINKED_PACKAGES], provider: "process" };
    }
    return {
      linked: peers,
      skipped: [...LINKED_PACKAGES],
      provider: "process",
      error: "Could not locate the Gloomberb install.",
    };
  }

  for (const pkg of LINKED_PACKAGES) {
    const target = linkTarget(hostRoot, pkg);
    if (!target) {
      skipped.push(pkg);
      continue;
    }
    try {
      ensureDirLink(join(pluginDir, "node_modules", pkg), target);
      linked.push(pkg);
    } catch (err) {
      skipped.push(pkg);
      if (pkg === "gloomberb") return { linked, skipped, provider: "symlink", error: String(err) };
    }
  }

  linked.push(...linkPeerPlugins(pluginDir, pluginsDir));

  return { linked, skipped, provider: "symlink" };
}
