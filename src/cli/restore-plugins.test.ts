import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { EXTRACTED_PLUGINS } from "../plugins/extracted-plugins";
import { createDefaultConfig } from "../types/config";

/**
 * An upgrade from before the built-in plugins moved to their own repositories
 * used to clone and install all of them before the first frame: seconds of
 * blank screen, or for good on a connection that hangs. The launch now only
 * plans the restore, offline, and installs once the app is up. These run the
 * real installer against local git remotes in a process of their own, since
 * the installer reads its plugins folder from the environment once.
 */

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A profile saved before the move: no record of restored plugins, and no plugins folder. */
function upgradeProfile(): { root: string; home: string; remotes: string } {
  const smoke = join(homedir(), ".cache", "gloom-smoke");
  mkdirSync(smoke, { recursive: true });
  const root = mkdtempSync(join(smoke, "plugin-restore-"));
  scratch.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const config: Record<string, unknown> = { ...createDefaultConfig(home), onboardingComplete: true };
  delete config.seededPlugins;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return { root, home, remotes: join(root, "remotes") };
}

/** Publishes `gloom-sh/<name>` as a local remote holding a minimal plugin, tagged `v1`. */
function publish(remotes: string, name: string, id: string): void {
  const dir = join(remotes, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.ts" }));
  writeFileSync(join(dir, "index.ts"), `export default { id: "${id}", name: "${id}", version: "1.0.0" };\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "v1"]);
  git(dir, ["tag", "v1"]);
}

/** Runs `body` with `restore` and `progress` in scope; a registry that answers with `registry`, or not at all when null. */
async function run(profile: { root: string; home: string; remotes: string }, body: string, registry: unknown): Promise<any> {
  const script = join(profile.root, "run.ts");
  writeFileSync(script, `
    globalThis.fetch = async (url) => ${registry === null ? "Promise.reject(new Error(\"offline\"))" : `String(url).endsWith("/registry.json")
      ? Response.json(${JSON.stringify(registry)})
      : Promise.reject(new Error("offline"))`};
    const restore = await import(${JSON.stringify(join(import.meta.dir, "restore-plugins.ts"))});
    const progress = await import(${JSON.stringify(join(import.meta.dir, "../plugins/seed-progress.ts"))});
    const { existsSync, readdirSync } = await import("fs");
    const pluginsDir = ${JSON.stringify(join(profile.home, "plugins"))};
    const folders = () => existsSync(pluginsDir) ? readdirSync(pluginsDir).sort() : [];
    console.log(JSON.stringify(await (async () => { ${body} })()));
  `);
  const child = Bun.spawn([process.execPath, script], {
    env: {
      ...process.env,
      GLOOMBERB_HOME: profile.home,
      GLOOMBERB_NO_TELEMETRY: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${profile.remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/gloom-sh/",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

const others = EXTRACTED_PLUGINS.filter((entry) => entry.id !== "polls").map((entry) => entry.id).sort();

test("an upgrade plans the restore without installing, then installs in the background and leaves what failed to the next launch", async () => {
  const profile = upgradeProfile();
  // Polls installs; every other repository is missing, as a failed clone.
  publish(profile.remotes, "gloom-polls", "polls");
  const result = await run(profile, `
    const launch = await restore.prepareExtractedPluginSeed();
    const planned = { states: [...new Set(progress.getPluginSeedProgress().plugins.map((entry) => entry.state))], folders: folders() };
    const record = await launch.start();
    const done = progress.getPluginSeedProgress();
    return {
      planned,
      record,
      installed: done.plugins.filter((entry) => entry.state === "installed").map((entry) => [entry.id, entry.directory]),
      failed: done.plugins.filter((entry) => entry.state === "failed").map((entry) => entry.id).sort(),
      notice: done.outcome.notice,
      folders: folders(),
    };
  `, { plugins: [{ id: "polls", name: "Polls", repo: "gloom-sh/gloom-polls", ref: "v1" }] });

  // Before the first frame: every plugin waits, and nothing has been cloned.
  expect(result.planned).toEqual({ states: ["installing"], folders: [] });
  expect(result.installed).toEqual([["polls", "gloom-polls"]]);
  expect(result.failed).toEqual(others);
  expect(result.folders).toEqual(["gloom-polls"]);
  // Only what installed counts as restored: the rest are tried again next launch.
  expect(result.record).toEqual({ seededPlugins: ["polls"], pluginSeedFailure: { plugins: others, gitMissing: false } });
  expect(result.notice).toEqual({ type: "info", body: `${others.length} official plugins could not be installed. Gloom tries again at the next launch.` });
}, 60_000);

test("offline, every install fails without holding anything up, nothing is recorded as restored, and the next launch plans them again", async () => {
  const profile = upgradeProfile();
  const result = await run(profile, `
    const launch = await restore.prepareExtractedPluginSeed();
    const started = Date.now();
    const record = await launch.start();
    const ms = Date.now() - started;
    const again = await restore.prepareExtractedPluginSeed();
    return { record, ms, folders: folders(), again: !!again.start };
  `, null);

  expect(result.record.seededPlugins).toEqual([]);
  expect(result.record.pluginSeedFailure.plugins).toEqual(EXTRACTED_PLUGINS.map((entry) => entry.id).sort());
  expect(result.ms).toBeLessThan(30_000);
  expect(result.folders).toEqual([]);
  expect(result.again).toBe(true);
  // The launch's own record is left for the app to save; the profile is as it was.
  expect(JSON.parse(readFileSync(join(profile.home, "config.json"), "utf8")).seededPlugins).toBeUndefined();
}, 60_000);

/**
 * A step past its time limit means the network is not answering, and each
 * plugin after it would wait out its own limit: ten in a row is many minutes
 * before the launch can say anything. The first stall ends this launch's
 * attempt, and the next launch tries all of them again.
 */
test("a clone that runs out of time leaves the rest to the next launch", async () => {
  const profile = upgradeProfile();
  const result = await run(profile, `
    const attempts = [];
    const launch = await restore.prepareExtractedPluginSeed({
      gitInstalled: () => true,
      loadRegistryListings: async () => new Map(),
      installListedPlugin: async (repo) => {
        attempts.push(repo);
        throw Object.assign(new Error("Failed to clone: no answer within 60 s"), { code: "install_timed_out" });
      },
    });
    const record = await launch.start();
    return { attempts, failed: record.pluginSeedFailure.plugins.length };
  `, null);
  expect(result).toEqual({ attempts: [EXTRACTED_PLUGINS[0].repo], failed: EXTRACTED_PLUGINS.length });
}, 60_000);

test("a fresh install, and a profile that restored everything, plan nothing and install nothing", async () => {
  const restored = upgradeProfile();
  const config = JSON.parse(readFileSync(join(restored.home, "config.json"), "utf8"));
  writeFileSync(join(restored.home, "config.json"), JSON.stringify({ ...config, seededPlugins: EXTRACTED_PLUGINS.map((entry) => entry.id) }));
  // A first launch: the data folder is there, its config not yet.
  const fresh = upgradeProfile();
  rmSync(join(fresh.home, "config.json"));
  for (const profile of [restored, fresh]) {
    const result = await run(profile, `
      const launch = await restore.prepareExtractedPluginSeed();
      return { start: launch?.start ?? null, progress: progress.getPluginSeedProgress(), folders: folders() };
    `, null);
    expect(result).toEqual({ start: null, progress: null, folders: [] });
  }
}, 60_000);
