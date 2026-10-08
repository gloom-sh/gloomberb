import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describeOlderCommit, hasLocalChanges, installPlugin, linkPlugin, parseRemoteHead } from "./installer";

/**
 * `git ls-remote` is the only way to know whether a plugin the registry does
 * not list has moved, and its output is a tab-separated line per ref. Anything
 * else, including the empty answer a repository we cannot reach gives, has to
 * read as "no answer" rather than as a commit.
 */
describe("parseRemoteHead", () => {
  test("takes the sha from the HEAD line", () => {
    expect(parseRemoteHead("abfdcf0aa3e4a0f6f0d2c8ab2cf4b0a0d9e1f234\tHEAD\n"))
      .toBe("abfdcf0aa3e4a0f6f0d2c8ab2cf4b0a0d9e1f234");
  });

  test("returns null for an empty or non-sha answer", () => {
    expect(parseRemoteHead("")).toBeNull();
    expect(parseRemoteHead("\n")).toBeNull();
    expect(parseRemoteHead("fatal: could not read Username for 'https://github.com'")).toBeNull();
    // Too short to be a commit, so it is something else that happened to be printed.
    expect(parseRemoteHead("abc123\tHEAD")).toBeNull();
  });
});

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date = "2026-01-01T00:00:00Z"): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).toString().trim();
}

/** A plugin repository with a `v1` tag, then one newer commit on `main`. */
function remote(versions: [tagged: string, head: string]): string {
  const dir = mkdtempSync(join(tmpdir(), "gloom-remote-"));
  scratch.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  versions.forEach((version, index) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version }));
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "--allow-empty", "-m", version], `2026-0${index + 1}-01T00:00:00Z`);
    if (index === 0) git(dir, ["tag", "v1"]);
  });
  return dir;
}

/** What the installer leaves: a depth-1 clone at `ref`, with `wanted` fetched beside it. */
function shallowCheckout(origin: string, ref: string, wanted: string): { dir: string; head: string; fetched: string } {
  const parent = mkdtempSync(join(tmpdir(), "gloom-plugin-"));
  scratch.push(parent);
  const dir = join(parent, "p");
  git(parent, ["clone", "-q", "--depth", "1", "--branch", ref, `file://${origin}`, dir]);
  git(dir, ["fetch", "-q", "--depth", "1", "origin", wanted]);
  return { dir, head: git(dir, ["rev-parse", "HEAD"]), fetched: git(dir, ["rev-parse", "FETCH_HEAD^{commit}"]) };
}

/**
 * The registry pins tags, and a checkout installed from the default branch
 * can be ahead of the newest one. Checking that tag out would downgrade it.
 * Installs are shallow, so the history that would settle it is usually not
 * there and the checkout itself has to say which commit is older.
 */
describe("describeOlderCommit", () => {
  test("keeps a checkout that is ahead of the registry's tag", () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.1.0", "1.2.0"]), "main", "v1");
    expect(describeOlderCommit(dir, head, fetched, "v1")).toBe("the registry's v1 is older than the installed 1.2.0");
  });

  test("tells commits apart by date when every commit has the same version", () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.0.0", "1.0.0"]), "main", "v1");
    expect(describeOlderCommit(dir, head, fetched, "v1")).toBe(`the registry's v1 is older than the installed ${head.slice(0, 7)}`);
  });

  test("lets a newer commit through", () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.0.0", "1.0.0"]), "v1", "main");
    expect(describeOlderCommit(dir, head, fetched)).toBeNull();
  });
});

/**
 * `update` checks commits out with --force, so a checkout with edits never
 * updates on its own. A lockfile `bun install` wrote beside the tracked files
 * is not an edit, or no plugin with dependencies would ever update.
 */
describe("hasLocalChanges", () => {
  test("counts edits to tracked files, not untracked ones", async () => {
    const dir = remote(["1.0.0", "1.1.0"]);
    expect(await hasLocalChanges(dir)).toBe(false);
    writeFileSync(join(dir, "bun.lock"), "{}");
    expect(await hasLocalChanges(dir)).toBe(false);
    writeFileSync(join(dir, "package.json"), "{}");
    expect(await hasLocalChanges(dir)).toBe(true);
  });
});

/**
 * Market Heatmap, Market Halts and Fear & Greed are built in again. A copy of
 * any of them only fetches code the loader skips, so it is refused before
 * anything is cloned or linked: under either product name, from a fork, or
 * from a checkout whose gloom.json says what it is under a folder name of its
 * own.
 */
describe("plugins that are built in now", () => {
  test.each([
    "gloom-sh/gloom-market-heatmap",
    "gloom-sh/gloom-fear-greed",
    "https://github.com/someone/gloomberb-market-halts",
  ])("refuses to install %s", async (ref) => {
    await expect(installPlugin(ref, { quiet: true })).rejects.toThrow(/is built into Gloomberb now\./);
  });

  test("refuses to link a checkout whose gloom.json names one", async () => {
    const parent = mkdtempSync(join(tmpdir(), "gloom-dev-"));
    scratch.push(parent);
    const dir = join(parent, "halts-dev");
    mkdirSync(dir);
    writeFileSync(join(dir, "gloom.json"), JSON.stringify({ id: "market-halts" }));
    writeFileSync(join(dir, "index.ts"), `export default { id: "market-halts", name: "Market Halts" };\n`);

    await expect(linkPlugin(dir, { quiet: true })).rejects.toThrow("Market Halts is built into Gloomberb now.");
  });
});

/**
 * IBKR Gateway imports Interactive Brokers. Bun remembers a failed import for
 * the life of the process, so importing a plugin before its sibling is
 * installed fails every later load in that session too, even after the
 * sibling arrives. These run the installer in a Bun process of their own,
 * against a throwaway plugins folder, with `fixture/*` cloned from disk and
 * the registry listing both fixtures at `v1`.
 */
describe("plugins that import a sibling plugin", () => {
  function publish(remotes: string, name: string, files: Record<string, string>) {
    const dir = join(remotes, `${name}.git`);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "v1"]);
    git(dir, ["tag", "v1"]);
  }

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "gloom-peers-"));
    scratch.push(root);
    const remotes = join(root, "remotes");
    publish(remotes, "gloom-fixture-peer", {
      "package.json": JSON.stringify({ name: "gloom-fixture-peer", main: "index.ts" }),
      "index.ts": `export default { id: "fixture-peer", name: "Fixture Peer" };\n`,
      "bridge.ts": `export const bridge = "Fixture Gateway";\n`,
    });
    // Shaped like IBKR Gateway: the entry imports a file that imports the sibling.
    publish(remotes, "gloom-fixture-gateway", {
      "package.json": JSON.stringify({
        name: "gloom-fixture-gateway",
        main: "index.ts",
        peerDependencies: { "gloom-fixture-peer": ">=1.0.0" },
        peerDependenciesMeta: { "gloom-fixture-peer": { optional: true } },
      }),
      "index.ts": `import { label } from "./plugin";\nexport default { id: "fixture-gateway", name: label };\n`,
      "plugin.ts": `import { bridge } from "gloom-fixture-peer/bridge";\nexport const label = bridge;\n`,
    });
    const home = join(root, "home");
    const run = async (body: string): Promise<any> => {
      const script = join(root, "run.ts");
      const registry = {
        plugins: [
          { id: "fixture-gateway", name: "Fixture Gateway", repo: "fixture/gloom-fixture-gateway", ref: "v1" },
          { id: "fixture-peer", name: "Fixture Peer", repo: "fixture/gloom-fixture-peer", ref: "v1" },
        ],
      };
      writeFileSync(script, `
        globalThis.fetch = async (url) => String(url).endsWith("/registry.json")
          ? Response.json(${JSON.stringify(registry)})
          : Promise.reject(new Error("offline"));
        const installer = await import(${JSON.stringify(join(import.meta.dir, "installer.ts"))});
        const loader = await import(${JSON.stringify(join(import.meta.dir, "loader.ts"))});
        const { createNodePluginManager } = await import(${JSON.stringify(join(import.meta.dir, "manager-node.ts"))});
        console.log(JSON.stringify(await (async () => { ${body} })()));
      `);
      const child = Bun.spawn([process.execPath, script], {
        env: {
          ...process.env,
          GLOOMBERB_HOME: home,
          GLOOMBERB_NO_TELEMETRY: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/fixture/",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" });
      return JSON.parse(stdout.trim().split("\n").pop()!);
    };
    return { home, run };
  }

  test("an install is not imported while its sibling is missing, so it loads once the sibling arrives", async () => {
    const { run } = setup();
    const result = await run(`
      const gateway = await installer.installPlugin("fixture/gloom-fixture-gateway", { quiet: true });
      await installer.installPlugin("fixture/gloom-fixture-peer", { quiet: true });
      const loaded = await loader.loadExternalPlugin(gateway.path, "cli", { fresh: true });
      return { validated: gateway.plugin, name: loaded.plugin.name, error: loaded.error ?? null, needsRestart: !!loaded.needsRestart };
    `);

    expect(result).toEqual({ validated: null, name: "Fixture Gateway", error: null, needsRestart: false });
  }, 30_000);

  test("an install from the app brings the sibling along and loads both", async () => {
    const { home, run } = setup();
    const result = await run(`
      const manager = createNodePluginManager("cli");
      const installed = await manager.install("fixture/gloom-fixture-gateway", { ref: "v1" });
      const loaded = [];
      for (const directory of [...(installed.peers ?? []), installed.directory]) {
        const entry = await manager.load(directory);
        loaded.push({ name: entry.plugin.name, error: entry.error ?? null });
      }
      return { installed, loaded };
    `);

    expect(result.installed).toEqual({ ok: true, directory: "gloom-fixture-gateway", peers: ["gloom-fixture-peer"] });
    expect(existsSync(join(home, "plugins", "gloom-fixture-peer", "bridge.ts"))).toBe(true);
    expect(result.loaded).toEqual([
      { name: "Fixture Peer", error: null },
      { name: "Fixture Gateway", error: null },
    ]);
  }, 30_000);
});
