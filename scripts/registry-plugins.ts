import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
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

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function runAsync(command: string, args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
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

async function checkoutRegistryPluginAsync(
  plugin: Pick<RegistryPlugin, "ref" | "commit">,
  url: string,
  dir: string,
): Promise<void> {
  if (!plugin.commit) {
    await runAsync("git", ["clone", "--quiet", "--depth", "1", ...(plugin.ref ? ["--branch", plugin.ref] : []), "--", url, dir], dirname(dir));
    return;
  }
  if (!FULL_COMMIT.test(plugin.commit)) throw new Error(`the registry's commit "${plugin.commit}" is not a full 40-character commit id`);
  const commit = plugin.commit.toLowerCase();
  mkdirSync(dir);
  try {
    await runAsync("git", ["init", "--quiet"], dir);
    await runAsync("git", ["fetch", "--quiet", "--depth", "1", "--", url, commit], dir);
    await runAsync("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
    const head = await runAsync("git", ["rev-parse", "HEAD"], dir);
    if (head !== commit) throw new Error(`checked out ${head.slice(0, 12)}, the registry reviewed ${plugin.commit}`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const count = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) break;
        await worker(items[index]!);
      }
    }),
  );
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
export async function cloneRegistryPlugins(
  pluginsDir: string,
  options: { concurrency?: number; reuseExisting?: boolean } = {},
): Promise<{ cloned: RegistryPluginCheckout[]; listed: number }> {
  const feed = await loadRegistry();
  const listed = feed.plugins.filter((plugin) => plugin.repo && !plugin.bundled);
  if (listed.length === 0) {
    annotate("warning", `No registry plugins to check${feed.error ? `: ${feed.error}` : ""}.`);
    return { cloned: [], listed: 0 };
  }

  const concurrency = options.concurrency ?? 8;
  const clonedByIndex = new Array<RegistryPluginCheckout | undefined>(listed.length);

  await runWithConcurrency(listed.map((plugin, index) => ({ plugin, index })), concurrency, async ({ plugin, index }) => {
    const dir = join(pluginsDir, plugin.repo!.split("/")[1]!);
    if (options.reuseExisting && existsSync(dir)) {
      clonedByIndex[index] = { id: plugin.id, dir };
      return;
    }
    try {
      await checkoutRegistryPluginAsync(plugin, `https://github.com/${plugin.repo}.git`, dir);
      clonedByIndex[index] = { id: plugin.id, dir };
    } catch (error) {
      const at = plugin.commit ?? plugin.ref;
      annotate("warning", `${plugin.id}: could not check out ${plugin.repo}${at ? ` at ${at}` : ""}: ${error}`);
      return;
    }
    try {
      // Peers are the host and sibling plugins.
      await runAsync("bun", ["install", "--production", "--omit", "peer", "--ignore-scripts"], dir);
    } catch (error) {
      annotate("warning", `${plugin.id}: bun install failed: ${error}`);
    }
  });

  const cloned = clonedByIndex.filter((entry): entry is RegistryPluginCheckout => entry !== undefined);
  return { cloned, listed: listed.length };
}
