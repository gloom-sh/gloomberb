import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "fs";
import { dirname, join, resolve } from "path";

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
 */

const LINKED_PACKAGES = ["gloomberb", "react", "react-dom"] as const;

let cachedHostRoot: string | null | undefined;

/** Walks up from this module to the directory holding the `gloomberb` package.json. */
export function findHostPackageRoot(startDir: string = import.meta.dir): string | null {
  if (cachedHostRoot !== undefined && startDir === import.meta.dir) return cachedHostRoot;
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8")) as { name?: string };
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

export interface HostLinkResult {
  linked: string[];
  skipped: string[];
  error?: string;
}

/**
 * Points `<pluginDir>/node_modules/{gloomberb,react,react-dom}` at the running
 * install. Safe to call repeatedly.
 */
export function linkHostPackages(pluginDir: string, hostRoot = findHostPackageRoot()): HostLinkResult {
  if (!hostRoot) return { linked: [], skipped: [...LINKED_PACKAGES], error: "Could not locate the Gloomberb install." };

  const modulesDir = join(pluginDir, "node_modules");
  const linked: string[] = [];
  const skipped: string[] = [];

  for (const pkg of LINKED_PACKAGES) {
    const target = linkTarget(hostRoot, pkg);
    if (!target) {
      skipped.push(pkg);
      continue;
    }
    const linkPath = join(modulesDir, pkg);
    if (alreadyLinked(linkPath, target)) {
      linked.push(pkg);
      continue;
    }
    try {
      mkdirSync(modulesDir, { recursive: true });
      // A real directory here means `bun install` fetched a second copy; replacing
      // it is the whole point, otherwise the plugin runs against a duplicate React.
      if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
        rmSync(linkPath, { recursive: true, force: true });
      }
      symlinkSync(target, linkPath, "dir");
      linked.push(pkg);
    } catch (err) {
      skipped.push(pkg);
      if (pkg === "gloomberb") return { linked, skipped, error: String(err) };
    }
  }

  return { linked, skipped };
}
