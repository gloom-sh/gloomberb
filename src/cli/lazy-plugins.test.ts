import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLoadablePlugins } from "../plugins/catalog";
import { buildCatalogSnapshot, renderCatalogSnapshot } from "./pane-functions/catalog-snapshot-build";

const root = join(import.meta.dir, "../..");

/**
 * The folder the command lines below run from, with the catalog snapshot a release build would write (not in
 * git, so built here), or none: either way the command reads this one and not a file a checkout may hold.
 */
let scratch = "";
beforeAll(async () => {
  const parent = join(homedir(), ".cache", "gloom-smoke");
  await mkdir(parent, { recursive: true });
  scratch = await mkdtemp(join(parent, "cli-lazy-plugins-"));
  await Bun.write(join(scratch, "snapshot.json"), renderCatalogSnapshot(await buildCatalogSnapshot(getLoadablePlugins([]))));
  await Bun.write(join(scratch, "preload.ts"), `
    import { plugin } from "bun";
    import { writeFileSync } from "node:fs";
    plugin({
      name: "catalog-snapshot",
      setup(build) {
        build.onResolve({ filter: /catalog-snapshot\\.json$/ }, () => ({ path: process.env.CATALOG_SNAPSHOT_FILE }));
      },
    });
    process.on("exit", () => writeFileSync(process.env.LOADED_MODULES, JSON.stringify(Object.keys(require.cache))));
  `);
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * What a command line prints and the built-in plugin modules (the plugins themselves, not the helpers a command
 * imports) it loads before it answers. The data service is unreachable, so a command that needs it fails at once,
 * after loading what it needs to ask.
 */
async function run(args: string[], snapshot: "built" | "absent" = "built"): Promise<{ plugins: string[]; stdout: string }> {
  const directory = await mkdtemp(join(scratch, "run-"));
  const loaded = join(directory, "loaded.json");
  const child = Bun.spawn([process.execPath, "--preload", join(scratch, "preload.ts"), join(root, "bin/gloom"), ...args], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: {
      ...process.env, GLOOMBERB_HOME: join(directory, "home"), GLOOMBERB_API_URL: "http://127.0.0.1:9",
      GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", LOADED_MODULES: loaded,
      CATALOG_SNAPSHOT_FILE: snapshot === "built" ? join(scratch, "snapshot.json") : join(scratch, "absent.json"),
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const modules = JSON.parse(await readFile(loaded, "utf8")) as string[];
    return { plugins: modules.flatMap((path) => path.match(/\/src\/plugins\/builtin\/composite\/([^/]+)\.ts$/)?.[1] ?? []).sort(), stdout };
  } finally {
    clearTimeout(timer);
  }
}

const loadedPlugins = async (args: string[]) => (await run(args)).plugins;

test("catalog and the commands that read market data load none of the composite plugins", async () => {
  expect(await loadedPlugins(["catalog", "GP"])).toEqual([]);
  expect(await loadedPlugins(["catalog", "operating margin", "--json"])).toEqual([]);
  expect(await loadedPlugins(["valuation", "V"])).toEqual([]);
}, 60_000);

test("fn loads the plugin that holds its function and no other", async () => {
  expect(await loadedPlugins(["fn", "HDS", "AAPL"])).toEqual(["ownership", "shared"]);
  expect(await loadedPlugins(["fn", "EQS"])).toEqual(["screeners"]);
  // A function of a plugin whose setup other plugins rely on (the chart composer's FRED cache), and a word no function answers to, ask them all.
  expect((await loadedPlugins(["fn", "SEC", "AAPL"])).length).toBeGreaterThan(10);
  expect((await loadedPlugins(["fn", "ZZZZ", "AAPL"])).length).toBeGreaterThan(10);
}, 90_000);

test("without a snapshot file the plugins are asked, and catalog prints what it prints with one", async () => {
  for (const args of [["catalog", "GP"], ["catalog", "operating margin"]]) {
    const absent = await run(args, "absent");
    expect(absent.plugins.length, args.join(" ")).toBeGreaterThan(10);
    expect(absent.stdout.length, args.join(" ")).toBeGreaterThan(0);
    expect(absent.stdout, args.join(" ")).toBe((await run(args)).stdout);
  }
  expect((await run(["fn", "HDS", "AAPL"], "absent")).plugins.length).toBeGreaterThan(10);
}, 120_000);
