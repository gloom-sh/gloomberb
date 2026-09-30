import { existsSync, readFileSync } from "fs";
import { join } from "path";
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
  } catch {
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

/**
 * Installs the dependencies of a plugin that was installed without them, and
 * relinks `gloomberb` and `react`, which `bun install` prunes. Runs through
 * `Bun.spawn` so the loader, which the desktop view also bundles, pulls in no
 * Node process module.
 */
export async function installPluginDependencies(pluginDir: string): Promise<boolean> {
  const bun = bunCommand();
  if (!bun) return false;
  let code: number | null = null;
  try {
    const child = Bun.spawn([bun.command, "install", "--production"], {
      cwd: pluginDir,
      env: bun.env ?? process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
    code = await child.exited;
  } catch {
    code = null;
  }
  linkHostPackages(pluginDir);
  return code === 0;
}
