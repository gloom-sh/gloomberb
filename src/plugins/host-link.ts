import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { dirname, join, resolve } from "path";

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
// host-contract.ts), so one that imports it should fail to resolve.
const LINKED_PACKAGES = ["gloomberb", "react"] as const;

let cachedHostRoot: string | null | undefined;

/** Walks up from this module to the directory holding the `gloomberb` package.json. */
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

function linkTarget(hostRoot: string, pkg: string): string | null {
  if (pkg === "gloomberb") return hostRoot;
  const candidate = join(hostRoot, "node_modules", pkg);
  return existsSync(candidate) ? candidate : null;
}

/** True when `path` is already a symlink pointing at `target`. */
function alreadyLinked(path: string, target: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(target);
  } catch {
    return false;
  }
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
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath, "dir");
}

/**
 * Links sibling plugins a plugin declares as peer dependencies.
 *
 * A plugin can legitimately extend another — IBKR Gateway builds on the Flex
 * plugin, which owns the broker id and the shared bridge. Those live in separate
 * install directories with no path between them, so the peer is linked the same
 * way the host is. A missing sibling is not an error here: the plugin reports it
 * at load, which is more useful than failing the install.
 */
function linkPeerPlugins(pluginDir: string, pluginsDir: string): string[] {
  const linked: string[] = [];
  let peers: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
    peers = Object.keys(pkg.peerDependencies ?? {}).filter(isPluginPackageName);
  } catch {
    return linked;
  }

  for (const peer of peers) {
    // Declared by package name, installed under a directory named for the repo:
    // the two disagree while the plugin is mid-rename.
    const target = pluginDirectoryNames(peer)
      .map((name) => join(pluginsDir, name))
      .find((candidate) => existsSync(candidate));
    if (!target) continue;
    try {
      ensureDirLink(join(pluginDir, "node_modules", peer), target);
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
