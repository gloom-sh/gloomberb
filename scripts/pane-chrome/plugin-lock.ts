import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { sleep } from "./browser";

/**
 * The registry plugins the UI checks build (ui-audit.ts `--registry`), pinned
 * to commits and kept in the replay folder beside the data they draw, so the
 * same snapshot always builds the same plugin code. A plugin author's push
 * reaches the checks only when main records the next snapshot
 * (docs/pane-conventions.md, "Holding the line").
 *
 * With no lock in the replay folder the registry is read, each plugin's ref
 * resolved to the commit it points to now, and the lock written, so every
 * later build that reads the folder (the head after the base, a second
 * picture) builds the same commits.
 */

const PLUGIN_LOCK = "plugins.lock.json";

interface LockedPlugin {
  id: string;
  repo: string;
  /** The registry's ref, or none for the default branch. */
  ref: string | null;
  commit: string;
}

interface PluginLock {
  resolvedAt: string;
  plugins: LockedPlugin[];
}

export async function readPluginLock(replayDir: string): Promise<PluginLock | null> {
  const file = join(replayDir, PLUGIN_LOCK);
  return existsSync(file) ? await Bun.file(file).json() as PluginLock : null;
}

const url = (repo: string) => `https://github.com/${repo}.git`;

function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: result.exitCode === 0, out: result.stdout.toString().trim() };
}

/** The commit `ref` (a branch or tag, or the default branch) points to now: an annotated tag's commit, not the tag. */
function remoteCommit(repo: string, ref: string | null): string | null {
  // An annotated tag is listed as the tag and, asked for, as `<tag>^{}`: the commit it peels to.
  const listed = git(["ls-remote", url(repo), ...(ref ? [ref, `${ref}^{}`] : ["HEAD"])]);
  if (!listed.ok) return null;
  const lines = listed.out.split("\n").filter(Boolean).map((line) => line.split("\t") as [string, string]);
  return (lines.find(([, name]) => name.endsWith("^{}")) ?? lines[0])?.[0] ?? null;
}

/**
 * The registry's plugins with a repo of their own, each at the commit its ref
 * points to now. A registry that cannot be read is retried, then the list
 * kept from the last read is used, so a network blip does not build none.
 */
async function resolveRegistry(pluginsDir: string): Promise<LockedPlugin[]> {
  const { loadRegistry } = await import("../../src/plugins/marketplace/feed");
  type Listed = Awaited<ReturnType<typeof loadRegistry>>["plugins"];
  const kept = join(pluginsDir, "registry.json");
  let listed: Listed = [];
  for (let attempt = 0; attempt < 3 && listed.length === 0; attempt += 1) {
    if (attempt) await sleep(2_000 * attempt);
    listed = (await loadRegistry({ force: attempt > 0 })).plugins;
  }
  if (listed.length) await Bun.write(kept, JSON.stringify(listed));
  else if (existsSync(kept)) {
    listed = await Bun.file(kept).json();
    console.warn(`The plugin registry could not be read: using the ${listed.length} plugins listed when it last was.`);
  } else {
    throw new Error("The plugin registry could not be read, and no list of its plugins is kept to build from.");
  }
  const plugins: LockedPlugin[] = [];
  for (const plugin of listed) {
    if (!plugin.repo || plugin.bundled) continue;
    const commit = plugin.commit ?? remoteCommit(plugin.repo, plugin.ref ?? null);
    if (!commit) { console.warn(`Left out ${plugin.id}: could not resolve ${plugin.repo}@${plugin.ref ?? "HEAD"}`); continue; }
    plugins.push({ id: plugin.id, repo: plugin.repo, ref: plugin.ref ?? null, commit });
  }
  return plugins;
}

/** The lock kept in `replayDir`, or the registry resolved now and kept there. */
export async function pluginLock(replayDir: string, pluginsDir: string): Promise<PluginLock> {
  const kept = await readPluginLock(replayDir);
  if (kept) return kept;
  const lock: PluginLock = { resolvedAt: new Date().toISOString(), plugins: await resolveRegistry(pluginsDir) };
  await mkdir(replayDir, { recursive: true });
  await Bun.write(join(replayDir, PLUGIN_LOCK), `${JSON.stringify(lock, null, 1)}\n`);
  return lock;
}

/**
 * A checkout of `plugin` at its locked commit under `pluginsDir`, its
 * dependencies installed; an older checkout of the same repo (a cache from
 * another week) is replaced. Null when the commit cannot be fetched.
 */
export async function checkoutPlugin(plugin: LockedPlugin, pluginsDir: string): Promise<string | null> {
  const dir = join(pluginsDir, plugin.repo.split("/")[1]!);
  if (existsSync(join(dir, "package.json")) && git(["rev-parse", "HEAD"], dir).out === plugin.commit) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const fetched = git(["init", "--quiet"], dir).ok
    && git(["fetch", "--quiet", "--depth", "1", url(plugin.repo), plugin.commit], dir).ok
    && git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir).ok;
  if (!fetched) {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  Bun.spawnSync(["bun", "install", "--production", "--omit", "peer", "--ignore-scripts"], { cwd: dir, stdout: "ignore", stderr: "inherit" });
  return dir;
}
