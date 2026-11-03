import { execFileSync } from "child_process";
import { join } from "path";

import { loadRegistry } from "../src/plugins/marketplace/feed";

/**
 * The registry's plugins as the two CI checks that read them see them
 * (check-registry-plugins.ts compiles them against this checkout,
 * check-packaged-registry-plugins.ts loads them in the terminal as it ships):
 * the same list, each plugin at the ref `gloomberb install` would land.
 *
 * Anything that goes wrong here (the registry or GitHub unreachable, a
 * dependency of a plugin's own that does not install) is a warning. These
 * jobs judge the host, not the plugins.
 */

export function annotate(level: "error" | "warning", message: string): void {
  console.log(process.env.GITHUB_ACTIONS ? `::${level}::${message}` : `${level}: ${message}`);
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

export interface RegistryPluginCheckout {
  id: string;
  dir: string;
}

/**
 * Clones every plugin the registry lists into `pluginsDir`, one folder each
 * named as the installer names it, so a plugin that builds on another
 * (Gateway on IBKR) finds it the same way. The plugin's own dependencies are
 * installed; the host and sibling plugins, its peers, are not. Returns what
 * was cloned; `listed` is how many plugins the registry lists, 0 when it
 * could not be read.
 */
export async function cloneRegistryPlugins(pluginsDir: string): Promise<{ cloned: RegistryPluginCheckout[]; listed: number }> {
  const feed = await loadRegistry();
  const listed = feed.plugins.filter((plugin) => plugin.repo && !plugin.bundled);
  if (listed.length === 0) {
    annotate("warning", `No registry plugins to check${feed.error ? `: ${feed.error}` : ""}.`);
    return { cloned: [], listed: 0 };
  }

  const cloned: RegistryPluginCheckout[] = [];
  for (const plugin of listed) {
    const dir = join(pluginsDir, plugin.repo!.split("/")[1]!);
    try {
      run("git", ["clone", "--quiet", "--depth", "1", ...(plugin.ref ? ["--branch", plugin.ref] : []), `https://github.com/${plugin.repo}.git`, dir], pluginsDir);
      cloned.push({ id: plugin.id, dir });
    } catch (error) {
      annotate("warning", `${plugin.id}: could not clone ${plugin.repo}${plugin.ref ? ` at ${plugin.ref}` : ""}: ${error}`);
    }
  }

  for (const { id, dir } of cloned) {
    try {
      // Peers are the host and sibling plugins.
      run("bun", ["install", "--production", "--omit", "peer", "--ignore-scripts"], dir);
    } catch (error) {
      annotate("warning", `${id}: bun install failed: ${error}`);
    }
  }
  return { cloned, listed: listed.length };
}
