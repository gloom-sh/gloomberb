import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { CrashReportsPayload } from "../api-client";
import { flushCrashReports, installCrashReporter, resetCrashReporterForTests } from "../telemetry/crash-reports";
import { VERSION } from "../version";
import { listPluginDirectories, loadExternalPlugin, readPluginCommit, unresolvedSpecifier } from "./loader";

const scratch: string[] = [];

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "gloom-plugin-"));
  scratch.push(dir);
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Read without spawning git, once per plugin at every startup. The three
 * layouts git actually writes are covered; anything else must come back null
 * rather than a wrong commit that the update check would then trust.
 */
describe("readPluginCommit", () => {
  test("reads a detached HEAD, which is what a pinned install leaves", () => {
    const dir = checkout();
    writeFileSync(join(dir, ".git", "HEAD"), `${SHA}\n`);
    expect(readPluginCommit(dir)).toBe(SHA);
  });

  test("follows a branch ref to its loose file", () => {
    const dir = checkout();
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "refs", "heads", "main"), `${SHA}\n`);
    expect(readPluginCommit(dir)).toBe(SHA);
  });

  test("falls back to packed-refs after git gc", () => {
    const dir = checkout();
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`);
    expect(readPluginCommit(dir)).toBe(SHA);
  });

  test("is null for a folder that is not a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "gloom-plain-"));
    scratch.push(dir);
    expect(readPluginCommit(dir)).toBeNull();
  });
});

function pluginAt(commit: string, files: Record<string, string>): string {
  const dir = checkout();
  writeFileSync(join(dir, ".git", "HEAD"), `${commit}\n`);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("loadExternalPlugin", () => {
  test.each([
    ["gloom.json", { "gloom.json": JSON.stringify({ id: "future", minGloom: "999.0.0" }) }],
    ["a gloomberb peer range", { "package.json": JSON.stringify({ name: "future", peerDependencies: { gloomberb: ">=999.0.0" } }) }],
  ])("does not import a checkout that needs a newer Gloomberb, from %s", async (_source, manifest) => {
    const dir = pluginAt(SHA, { ...manifest, "index.ts": `throw new Error("imported");\n` });

    const loaded = await loadExternalPlugin(dir);

    expect(loaded?.needsGloomberb).toBe("999.0.0");
    expect(loaded?.error).toBe(`Needs Gloomberb 999.0.0, this is ${VERSION}.`);
  });

  test("names the host export a stale plugin imports, from Bun's own error", async () => {
    const dir = pluginAt(SHA, {
      "index.ts": `import { RemovedLongAgo } from "gloomberb/theme";\nexport default { id: "stale", name: "Stale", RemovedLongAgo };\n`,
    });

    const loaded = await loadExternalPlugin(dir);

    expect(loaded?.error).toBe(
      `Uses RemovedLongAgo from gloomberb/theme, which Gloomberb ${VERSION} does not have. Update the plugin, or Gloomberb if the plugin is newer.`,
    );
  });

  test("asks for a restart when a plugin split across files changes after it was imported", async () => {
    // Bun re-reads only the entry on a fresh import and keeps the other files
    // cached, so calling the update done would leave old code running.
    const dir = pluginAt(SHA, {
      "index.ts": `import { label } from "./label";\nexport default { id: "split", name: label };\n`,
      "label.ts": `export const label = "Split";\n`,
    });
    expect((await loadExternalPlugin(dir))?.needsRestart).toBeUndefined();

    writeFileSync(join(dir, "label.ts"), `export const label = "Split 2";\n`);
    writeFileSync(join(dir, ".git", "HEAD"), `${"1".repeat(40)}\n`);
    expect((await loadExternalPlugin(dir, "cli", { fresh: true }))?.needsRestart).toBe(true);
  });
});

/**
 * An import of IBKR Gateway that ran before Interactive Brokers was linked
 * fails, and Bun keeps that failure for the rest of the process. Loading the
 * gateway after the sibling arrives needs a restart, not a crash report. A
 * sibling that really lacks the module is still a failure.
 */
describe("a plugin whose sibling plugin was linked after its import failed", () => {
  afterEach(() => resetCrashReporterForTests());

  function setup(peerFiles: Record<string, string>) {
    const pluginsDir = mkdtempSync(join(tmpdir(), "gloom-plugins-"));
    scratch.push(pluginsDir);
    const folder = (name: string, files: Record<string, string>) => {
      mkdirSync(join(pluginsDir, name));
      for (const [file, content] of Object.entries(files)) writeFileSync(join(pluginsDir, name, file), content);
      return join(pluginsDir, name);
    };
    const gateway = folder("gloom-fixture-gateway", {
      "package.json": JSON.stringify({ name: "gloom-fixture-gateway", main: "index.ts", peerDependencies: { "gloom-fixture-peer": ">=1.0.0" } }),
      "index.ts": `import { label } from "./plugin";\nexport default { id: "fixture-gateway", name: label };\n`,
      "plugin.ts": `import { bridge } from "gloom-fixture-peer/bridge";\nexport const label = bridge;\n`,
    });
    const addPeer = () => folder("gloom-fixture-peer", { "package.json": JSON.stringify({ name: "gloom-fixture-peer" }), ...peerFiles });
    const sent: CrashReportsPayload[] = [];
    resetCrashReporterForTests();
    installCrashReporter({
      surface: "terminal",
      isEnabled: () => true,
      getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
      send: async (payload) => { sent.push(payload); },
    });
    return { gateway, addPeer, sent };
  }

  test("asks for a restart when the module is there now", async () => {
    const { gateway, addPeer, sent } = setup({ "bridge.ts": `export const bridge = "Fixture Gateway";\n` });
    await import(join(gateway, "index.ts")).catch(() => {});
    addPeer();

    const loaded = await loadExternalPlugin(gateway, "cli", { fresh: true });
    await flushCrashReports({ timeoutMs: 500 });

    expect({ needsRestart: loaded?.needsRestart, error: loaded?.error }).toEqual({ needsRestart: true, error: undefined });
    expect(sent).toEqual([]);
  });

  test("still fails and reports a module the sibling does not have", async () => {
    const { gateway, addPeer, sent } = setup({ "index.ts": `export default { id: "fixture-peer", name: "Fixture Peer" };\n` });
    addPeer();

    const loaded = await loadExternalPlugin(gateway, "cli", { fresh: true });
    await flushCrashReports({ timeoutMs: 500 });

    // Bun 1.3 names the module, 1.4 the package alone.
    const unresolved = /Cannot find (?:module 'gloom-fixture-peer\/bridge'|package 'gloom-fixture-peer')/;
    expect(loaded?.needsRestart).toBeUndefined();
    expect(loaded?.error).toMatch(unresolved);
    expect(sent.flatMap((payload) => payload.errors.map((error) => error.message))).toEqual([
      expect.stringMatching(unresolved),
    ]);
  });

  test("checks the subpath when the message names only the package", () => {
    // Bun 1.4's wording for `import "gloom-fixture-peer/bridge"`: the peer's
    // index exists, so judging by the package alone would ask for a restart.
    const err = Object.assign(new Error("Cannot find package 'gloom-fixture-peer' imported from /plugins/gloom-fixture-gateway/plugin.ts"), {
      code: "ERR_MODULE_NOT_FOUND",
      specifier: "gloom-fixture-peer/bridge",
    });
    expect(unresolvedSpecifier(err, err.message)).toBe("gloom-fixture-peer/bridge");
    expect(unresolvedSpecifier(new Error("x"), "Cannot find module 'gloom-fixture-peer/bridge' from '/plugins/a.ts'")).toBe("gloom-fixture-peer/bridge");
  });
});

/**
 * Market Heatmap, Market Halts and Fear & Greed are built in again, and
 * upgraded installs still have their external checkouts. Loaded beside the
 * built-in, one fails on the duplicate id and reports a crash on every launch,
 * so the loader skips it before linking or importing anything, and leaves the
 * folder as it is for an older Gloomberb that may share it.
 */
describe("leftover checkouts of plugins that are built in now", () => {
  const imported = `throw new Error("imported");\n`;

  test("are skipped under either product name, by gloom.json id, and when linked", async () => {
    const pluginsDir = mkdtempSync(join(tmpdir(), "gloom-plugins-"));
    const devDir = mkdtempSync(join(tmpdir(), "gloom-dev-"));
    scratch.push(pluginsDir, devDir);
    const folder = (parent: string, name: string, files: Record<string, string>) => {
      mkdirSync(join(parent, name));
      for (const [file, content] of Object.entries(files)) writeFileSync(join(parent, name, file), content);
      return join(parent, name);
    };
    folder(pluginsDir, "gloom-market-heatmap", { "index.ts": imported });
    folder(pluginsDir, "gloom-fear-greed", { "index.ts": imported });
    folder(pluginsDir, "gloomberb-market-halts", { "index.ts": imported });
    folder(pluginsDir, "heatmap-fork", { "gloom.json": JSON.stringify({ id: "market-heatmap" }), "index.ts": imported });
    symlinkSync(folder(devDir, "gloom-market-halts", { "index.ts": imported }), join(pluginsDir, "gloom-market-halts"), "dir");
    folder(pluginsDir, "weather", { "index.ts": `export default { id: "weather", name: "Weather" };\n` });

    expect(await listPluginDirectories(pluginsDir)).toEqual([join(pluginsDir, "weather")]);
    const leftovers = ["gloom-market-heatmap", "gloom-fear-greed", "gloomberb-market-halts", "heatmap-fork", "gloom-market-halts"];
    for (const name of leftovers) {
      const dir = join(pluginsDir, name);
      expect(await loadExternalPlugin(dir)).toBeNull();
      expect(existsSync(join(dir, "node_modules"))).toBe(false);
    }
  });

  test("are skipped by the id they export when there is no gloom.json", async () => {
    const dir = pluginAt(SHA, { "index.ts": `export default { id: "market-halts", name: "Market Halts" };\n` });
    expect(await loadExternalPlugin(dir)).toBeNull();
  });
});
