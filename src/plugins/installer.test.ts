import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";

import { describeOlderCommit, hasLocalChanges, installPlugin, linkPlugin, parseGitHubRef, parseRemoteHead, readPluginRemoteAsync, validatePinRef, validatePluginDirectoryName } from "./installer";

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

// The update check knows an official plugin by its GitHub remote, so a
// remote read wrong stops that plugin's updates without a word.
test("the update check reads a clone's GitHub repo, and none from a repository without an origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gloom-plugin-"));
  scratch.push(dir);
  git(dir, ["init", "-q"]);
  expect(await readPluginRemoteAsync(dir)).toBeNull();
  git(dir, ["remote", "add", "origin", "git@github.com:gloom-sh/gloom-polls.git"]);
  expect(await readPluginRemoteAsync(dir)).toBe("gloom-sh/gloom-polls");
});

/**
 * Runs `body` in a Bun process of its own, with `installer`, `loader` and
 * `createNodePluginManager` in scope: the installer reads its plugins folder
 * once, from the environment, so each test's folder needs a process. `fetch`
 * answers the registry with `registry` and fails anything else. Returns what
 * `body` returns.
 */
async function runIsolated(root: string, body: string, env: Record<string, string>, registry: unknown = { plugins: [] }): Promise<any> {
  const script = join(root, "run.ts");
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
    env: { ...process.env, GLOOMBERB_NO_TELEMETRY: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

/**
 * A launch installs the plugins that moved out of Gloom in the background,
 * and a connection that stalls mid-clone used to hold that install for good.
 * Each git command now has a time limit: past it, git and the helpers it
 * started are stopped, the install fails with a plain reason, and nothing is
 * left in the plugins folder for the next launch to take for an install.
 */
test.skipIf(process.platform === "win32")("a clone that stalls is stopped at its time limit and leaves nothing behind", async () => {
  const smoke = join(homedir(), ".cache", "gloom-smoke");
  mkdirSync(smoke, { recursive: true });
  const root = mkdtempSync(join(smoke, "plugin-stall-"));
  scratch.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // A git that never answers, does not stop when asked to, and waits on a helper of its own.
  writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nsleep 29.517\n");
  chmodSync(join(bin, "git"), 0o755);
  const home = join(root, "home");

  const result = await runIsolated(root, `
    const started = Date.now();
    const error = await installer.installPlugin("fixture/gloom-fixture-stall", { quiet: true, timeouts: { gitMs: 1000, dependenciesMs: 1000 } })
      .then(() => null, (failure) => ({ message: failure.message, code: failure.code }));
    const { readdirSync } = await import("fs");
    return { error, ms: Date.now() - started, left: readdirSync(loader.getPluginsDir()) };
  `, { GLOOMBERB_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH}` });

  expect(result.error).toEqual({ message: "Failed to clone https://github.com/fixture/gloom-fixture-stall.git: no answer within 1 s", code: "install_timed_out" });
  expect(result.ms).toBeLessThan(10_000);
  expect(result.left).toEqual([]);
  // The process ended only once the stalled command was gone, and it took its helpers along.
  const running = execFileSync("ps", ["-A", "-o", "args="]).toString();
  expect(running).not.toContain(join(bin, "git"));
  expect(running).not.toContain("sleep 29.517");
}, 30_000);

/**
 * The registry pins tags, and a checkout installed from the default branch
 * can be ahead of the newest one. Checking that tag out would downgrade it.
 * Installs are shallow, so the history that would settle it is usually not
 * there and the checkout itself has to say which commit is older.
 */
describe("describeOlderCommit", () => {
  test("keeps a checkout that is ahead of the registry's tag", async () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.1.0", "1.2.0"]), "main", "v1");
    expect(await describeOlderCommit(dir, head, fetched, "v1")).toBe("the registry's v1 is older than the installed 1.2.0");
  });

  test("tells commits apart by date when every commit has the same version", async () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.0.0", "1.0.0"]), "main", "v1");
    expect(await describeOlderCommit(dir, head, fetched, "v1")).toBe(`the registry's v1 is older than the installed ${head.slice(0, 7)}`);
  });

  test("lets a newer commit through", async () => {
    const { dir, head, fetched } = shallowCheckout(remote(["1.0.0", "1.0.0"]), "v1", "main");
    expect(await describeOlderCommit(dir, head, fetched)).toBeNull();
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
    await expect(installPlugin(ref, { quiet: true })).rejects.toThrow(/is built into Gloom now\./);
  });

  test("refuses to link a checkout whose gloom.json names one", async () => {
    const parent = mkdtempSync(join(tmpdir(), "gloom-dev-"));
    scratch.push(parent);
    const dir = join(parent, "halts-dev");
    mkdirSync(dir);
    writeFileSync(join(dir, "gloom.json"), JSON.stringify({ id: "market-halts" }));
    writeFileSync(join(dir, "index.ts"), `export default { id: "market-halts", name: "Market Halts" };\n`);

    await expect(linkPlugin(dir, { quiet: true })).rejects.toThrow("Market Halts is built into Gloom now.");
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
    const smoke = join(homedir(), ".cache", "gloom-smoke");
    mkdirSync(smoke, { recursive: true });
    const root = mkdtempSync(join(smoke, "plugin-peers-"));
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
    const registry = {
      plugins: [
        { id: "fixture-gateway", name: "Fixture Gateway", repo: "fixture/gloom-fixture-gateway", ref: "v1" },
        { id: "fixture-peer", name: "Fixture Peer", repo: "fixture/gloom-fixture-peer", ref: "v1" },
      ],
    };
    const run = (body: string) => runIsolated(root, body, {
      GLOOMBERB_HOME: home,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/fixture/",
    }, registry);
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

// The pin's ref goes to git clone and git fetch; one starting with a dash would be read as an option.
test("a registry pin's ref is a tag or branch name, never an option or a range", () => {
  for (const ref of ["v1", "v1.2.3", "release/2026-11", "main", "v2.0.0-rc.1+build"]) expect(validatePinRef(ref)).toBe(ref);
  for (const ref of ["-x", "--upload-pack=touch pwned", "v1..v2", "a//b", "v1/", "v1.", "v1.lock", "a@{1}", "a b", "v1\n", ""]) {
    expect(() => validatePinRef(ref)).toThrow("Invalid ref");
  }
});

test("plugin names and references consume the complete name, including a trailing line ending", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    expect(() => validatePluginDirectoryName(`gloom-example${suffix}`)).toThrow("Invalid plugin name");
    expect(() => parseGitHubRef(`owner/gloom-example${suffix}`)).toThrow();
    expect(() => parseGitHubRef(`owner${suffix}/gloom-example`)).toThrow();
  }
  expect(parseGitHubRef("owner/gloom-example.git")).toEqual({
    url: "https://github.com/owner/gloom-example.git", name: "gloom-example", repo: "owner/gloom-example",
  });
});

test.skipIf(process.platform === "win32")("git is resolved before entering a plugin checkout, even with a relative PATH entry", async () => {
  const dir = remote(["1.0.0", "1.1.0"]);
  const marker = join(dir, "local-git-ran");
  writeFileSync(join(dir, "git"), "#!/bin/sh\ntouch local-git-ran\nexit 0\n");
  chmodSync(join(dir, "git"), 0o755);
  writeFileSync(join(dir, "package.json"), "{}");
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `.${delimiter}${previousPath}`;
    expect(await hasLocalChanges(dir)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
