import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

/**
 * The built-in plugin modules (the plugins themselves, not the helpers a command imports) a command line loads
 * before it answers. The data service is unreachable, so a command that needs it fails at once, after loading
 * what it needs to ask.
 */
async function loadedPlugins(args: string[]): Promise<string[]> {
  const parent = join(homedir(), ".cache", "gloom-smoke");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "cli-lazy-plugins-"));
  const preload = join(directory, "preload.ts");
  const loaded = join(directory, "loaded.json");
  try {
    await Bun.write(preload, `
      import { writeFileSync } from "node:fs";
      process.on("exit", () => writeFileSync(process.env.LOADED_MODULES, JSON.stringify(Object.keys(require.cache))));
    `);
    const child = Bun.spawn([process.execPath, "--preload", preload, join(root, "bin/gloom"), ...args], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env, GLOOMBERB_HOME: join(directory, "home"), GLOOMBERB_API_URL: "http://127.0.0.1:9",
        GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", LOADED_MODULES: loaded,
      },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    } finally {
      clearTimeout(timer);
    }
    const modules = JSON.parse(await readFile(loaded, "utf8")) as string[];
    return modules.flatMap((path) => path.match(/\/src\/plugins\/builtin\/composite\/([^/]+)\.ts$/)?.[1] ?? []).sort();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
