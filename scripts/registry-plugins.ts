import { execFileSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";

import { loadRegistry } from "../src/plugins/marketplace/feed";
import type { RegistryPlugin } from "../src/plugins/marketplace/model";

/**
 * The registry's plugins as the two CI checks that read them see them
 * (check-registry-plugins.ts compiles them against this checkout,
 * check-packaged-registry-plugins.ts loads them in the terminal as it ships):
 * the same list, each plugin at the commit the registry reviewed, or at the
 * ref `gloomberb install` would land when the registry names no commit.
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

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/**
 * Puts `plugin` in `dir` (which must not exist yet) from `url`. With a
 * commit from the registry, that commit and nothing else: the checkout ends
 * on it or throws, and leaves nothing behind when it throws. The commit has
 * to be a full 40-character id, which git can fetch as it is; an abbreviated
 * one throws, as git cannot fetch it and the check would have to trust a ref
 * for it. Without a commit, the ref or the default branch.
 */
export function checkoutRegistryPlugin(
  plugin: Pick<RegistryPlugin, "ref" | "commit">,
  url: string,
  dir: string,
): void {
  if (!plugin.commit) {
    git(["clone", "--quiet", "--depth", "1", ...(plugin.ref ? ["--branch", plugin.ref] : []), "--", url, dir], dirname(dir));
    return;
  }
  if (!FULL_COMMIT.test(plugin.commit)) throw new Error(`the registry's commit "${plugin.commit}" is not a full 40-character commit id`);
  const commit = plugin.commit.toLowerCase();
  mkdirSync(dir);
  try {
    git(["init", "--quiet"], dir);
    git(["fetch", "--quiet", "--depth", "1", "--", url, commit], dir);
    git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
    const head = git(["rev-parse", "HEAD"], dir);
    if (head !== commit) throw new Error(`checked out ${head.slice(0, 12)}, the registry reviewed ${plugin.commit}`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
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
      checkoutRegistryPlugin(plugin, `https://github.com/${plugin.repo}.git`, dir);
      cloned.push({ id: plugin.id, dir });
    } catch (error) {
      const at = plugin.commit ?? plugin.ref;
      annotate("warning", `${plugin.id}: could not check out ${plugin.repo}${at ? ` at ${at}` : ""}: ${error}`);
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
