import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { logFailure } from "../utils/log-failure";
import { linkHostPackages } from "./host-link";

/**
 * The Bun that installs a plugin's dependencies, and the environment to run
 * it in. A packaged desktop app and the compiled terminal usually have no
 * `bun` on PATH (an app opened from the Finder gets a minimal PATH), and the
 * install then failed quietly, leaving plugins such as BYOK AI without their
 * packages. The running executable is Bun either way: the desktop's Bun
 * process is the bun binary itself, and a compiled binary acts as the Bun CLI
 * when BUN_BE_BUN is set.
 */
export function bunCommand(): { command: string; env?: NodeJS.ProcessEnv } | null {
  const onPath = typeof Bun !== "undefined" ? Bun.which("bun") : null;
  if (onPath) return { command: onPath };
  if (typeof Bun === "undefined") return null;
  return { command: process.execPath, env: { ...process.env, BUN_BE_BUN: "1" } };
}

function declaredDependencies(packageDir: string): string[] {
  try {
    const dependencies = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dependencies;
    return dependencies && typeof dependencies === "object" ? Object.keys(dependencies) : [];
  } catch (error) {
    // A missing manifest is optional; malformed or unreadable manifests are failures.
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") {
      logFailure("plugin-dependencies", "Dependency manifest read failed")(error);
    }
    return [];
  }
}

/**
 * Runtime dependencies a plugin declares that are not in its `node_modules`,
 * and the packages those need, one level down: an install cut short left BYOK
 * AI with `@earendil-works/pi-ai` but not the `partial-json` it imports.
 */
export function missingPluginDependencies(pluginDir: string): string[] {
  const modules = join(pluginDir, "node_modules");
  const missing: string[] = [];
  for (const name of declaredDependencies(pluginDir)) {
    const packageDir = join(modules, name);
    if (!existsSync(join(packageDir, "package.json"))) {
      missing.push(name);
      continue;
    }
    for (const nested of declaredDependencies(packageDir)) {
      const found = existsSync(join(modules, nested, "package.json"))
        || existsSync(join(packageDir, "node_modules", nested, "package.json"));
      if (!found) missing.push(nested);
    }
  }
  return [...new Set(missing)];
}

interface DependencyInstall {
  directory: string;
  startedAt: number;
  endedAt?: number;
  code?: number | null;
  done: Promise<unknown>;
}

/**
 * Every `bun install` this process ran in a plugin folder. It prunes the
 * links to the host and to sibling plugins until they are made again, so an
 * import that fails on a sibling waits for one still running, and its crash
 * report says which ran.
 */
const installs = new Map<string, DependencyInstall>();

/** Runs `install`, a `bun install` in `pluginDir`, on the record. */
export async function recordDependencyInstall<T extends { code?: number | null } | number | null>(
  pluginDir: string,
  install: () => Promise<T>,
): Promise<T> {
  const done = install();
  const settled = done.catch(() => {
    // Intentional ignore: the caller awaits this same promise and handles its failure.
  });
  const entry: DependencyInstall = { directory: basename(pluginDir), startedAt: Date.now(), done: settled };
  installs.set(pluginDir, entry);
  try {
    const result = await done;
    entry.code = typeof result === "number" || result === null ? result : result.code ?? null;
    return result;
  } catch (error) {
    entry.code = null;
    throw error;
  } finally {
    entry.endedAt = Date.now();
  }
}

/** Waits, at most `timeoutMs`, for installs still running in any of `pluginDirs`. */
export async function settleDependencyInstalls(pluginDirs: readonly string[], timeoutMs: number): Promise<void> {
  const running = pluginDirs.map((dir) => installs.get(dir)).filter((entry) => entry && entry.endedAt === undefined);
  if (running.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(running.map((entry) => entry!.done)),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
}

/** `gloom-ibkr-gateway:0@12s`, one per install this process ran, newest first; `running` while it runs. */
export function describeDependencyInstalls(now: number = Date.now()): string[] {
  return [...installs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((entry) => entry.endedAt === undefined
      ? `${entry.directory}:running`
      : `${entry.directory}:${entry.code ?? "?"}@${Math.round((now - entry.endedAt) / 1000)}s`);
}

/**
 * Installs the dependencies of a plugin that was installed without them, and
 * relinks `gloomberb` and `react`, which `bun install` prunes. Runs through
 * `Bun.spawn` so the loader, which the desktop view also bundles, pulls in no
 * Node process module.
 */
export async function installPluginDependencies(pluginDir: string): Promise<boolean> {
  const bun = bunCommand();
  if (!bun) return false;
  const code = await recordDependencyInstall(pluginDir, async () => {
    try {
      const child = Bun.spawn([bun.command, "install", "--production"], {
        cwd: pluginDir,
        env: bun.env ?? process.env,
        stdout: "ignore",
        stderr: "ignore",
      });
      return await child.exited;
    } catch (error) {
      logFailure("plugin-dependencies", "Dependency installer launch failed")(error);
      return null;
    }
  });
  linkHostPackages(pluginDir);
  return code === 0;
}
