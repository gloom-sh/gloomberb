import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

/** Runtime dependencies a plugin declares that are not in its `node_modules`. */
export function missingPluginDependencies(pluginDir: string): string[] {
  let dependencies: unknown;
  try {
    dependencies = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8")).dependencies;
  } catch {
    return [];
  }
  if (!dependencies || typeof dependencies !== "object") return [];
  return Object.keys(dependencies).filter((name) => !existsSync(join(pluginDir, "node_modules", name, "package.json")));
}
