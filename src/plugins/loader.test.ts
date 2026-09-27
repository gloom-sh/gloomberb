import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { VERSION } from "../version";
import { listPluginDirectories, loadExternalPlugin, readPluginCommit } from "./loader";

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
 * Market Heatmap and Market Halts are built in again, and upgraded installs
 * still have their external checkouts. Loaded beside the built-in, one fails
 * on the duplicate id and reports a crash on every launch, so the loader
 * skips it before linking or importing anything, and leaves the folder as it
 * is for an older Gloomberb that may share it.
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
    folder(pluginsDir, "gloomberb-market-halts", { "index.ts": imported });
    folder(pluginsDir, "heatmap-fork", { "gloom.json": JSON.stringify({ id: "market-heatmap" }), "index.ts": imported });
    symlinkSync(folder(devDir, "gloom-market-halts", { "index.ts": imported }), join(pluginsDir, "gloom-market-halts"), "dir");
    folder(pluginsDir, "weather", { "index.ts": `export default { id: "weather", name: "Weather" };\n` });

    expect(await listPluginDirectories(pluginsDir)).toEqual([join(pluginsDir, "weather")]);
    for (const name of ["gloom-market-heatmap", "gloomberb-market-halts", "heatmap-fork", "gloom-market-halts"]) {
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
