import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, type Stats } from "fs";
import { basename, dirname, join, resolve } from "path";

import { installPluginHostResolver } from "./host-resolver";
import { isPluginPackageName, pluginDirectoryNames } from "./plugin-names";

/**
 * External plugins live in `~/.gloomberb/plugins/<name>/`, outside any
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
        // Unreadable package.json — keep walking rather than giving up.
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
    } catch {
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
  } catch {
    return null;
  }
}

/** True when `path` is already a link pointing at `target`. Compared by real
 * path: Windows spells a junction's target its own way. */
function alreadyLinked(path: string, target: string): boolean {
  try {
    return isLink(path, lstatSync(path)) && realpathSync(path) === realpathSync(target);
  } catch {
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
 * Makes `linkPath` a directory symlink to `target`, replacing whatever is
 * there. A real directory means `bun install` fetched a second copy; replacing
 * it is the whole point, otherwise the plugin runs against a duplicate React.
 * Throws when the link cannot be made.
 */
function ensureDirLink(linkPath: string, target: string): void {
  if (alreadyLinked(linkPath, target)) return;
  mkdirSync(dirname(linkPath), { recursive: true });
  const existing = lstatSync(linkPath, { throwIfNoEntry: false });
  if (existing && isLink(linkPath, existing)) unlinkSync(linkPath);
  else if (existing) rmSync(linkPath, { recursive: true, force: true });
  // A directory symlink on Windows needs Developer Mode or admin rights, and
  // without them every external plugin lost `gloomberb` and `react`. A
  // junction needs neither; other platforms ignore the type.
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
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
  let peers: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
    peers = Object.keys(pkg.peerDependencies ?? {}).filter(isPluginPackageName);
  } catch {
    return [];
  }
  return peers.filter((peer) => !pluginDirectoryNames(peer).some((name) => existsSync(join(pluginsDir, name))));
}

export function installedPeerPlugins(pluginDir: string, pluginsDir: string = dirname(pluginDir)): Array<{ peer: string; directory: string }> {
  let peers: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
    peers = Object.keys(pkg.peerDependencies ?? {}).filter(isPluginPackageName);
  } catch {
    return [];
  }
  const installed: Array<{ peer: string; directory: string }> = [];
  for (const peer of peers) {
    // Declared by package name, installed under a directory named for the repo:
    // the two disagree while the plugin is mid-rename.
    const directory = pluginDirectoryNames(peer).find((name) => existsSync(join(pluginsDir, name)));
    if (directory) installed.push({ peer, directory });
  }
  return installed;
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
    } catch {
      // Reported by the plugin's own load failure if it actually needed it.
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
