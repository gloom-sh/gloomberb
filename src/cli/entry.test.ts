import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../types/config";

async function smokeDirectory() {
  const parent = join(homedir(), ".cache", "gloom-smoke");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "cli-cold-start-entry-"));
}

test("packaged UI launches restore once before loading the TUI catalog; headless commands do not restore", async () => {
  const root = join(import.meta.dir, "../..");
  const directory = await smokeDirectory();
  const preload = join(directory, "preload.ts");
  const modulePath = (path: string) => JSON.stringify(join(root, "src", path));
  try {
    // Isolate module mocks from the rest of the suite, while exercising the shipped bin entry.
    await Bun.write(preload, `
      import { mock } from "bun:test";
      const calls = [];
      let restored = false;
      mock.module(${modulePath("cli/restore-plugins.ts")}, () => ({ restoreExtractedPlugins: async () => {
        calls.push("restore"); restored = true;
      }}));
      mock.module(${modulePath("plugins/loader.ts")}, () => ({ loadExternalPlugins: async (target = "cli") => {
        calls.push("catalog:" + target);
        return restored ? [{ plugin: { id: "tv" }, path: "tv" }] : [];
      }}));
      mock.module(${modulePath("cli/index.ts")}, () => ({
        dispatchCli: async (args, options) => {
          calls.push("dispatch:" + args[0]);
          await options.loadExternalPlugins();
          return args[0] === "handoff" ? { kind: "launch-ui", request: { source: "handoff" } } : { kind: "handled" };
        },
        failUnknownCliCommand: async () => {},
      }));
      mock.module(${modulePath("renderers/opentui/start.tsx")}, () => ({ startOpenTuiApp: async (options) => {
        calls.push({ launch: options.externalPlugins.map((entry) => entry.plugin.id), request: options.cliLaunchRequest });
      }}));
      process.on("beforeExit", () => console.log(JSON.stringify(calls)));
    `);
    for (const args of [[], ["ui"], ["launch-ui", "TV"], ["handoff"], ["help"]]) {
      const child = Bun.spawn([process.execPath, "--preload", preload, join(root, "bin/gloom"), ...args], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
      const calls = JSON.parse(stdout.trim());
      if (args[0] === "help") {
        expect(calls).toEqual(["dispatch:help", "catalog:cli"]);
      } else {
        expect(calls).toEqual([
          ...(args[0] === "handoff" ? ["dispatch:handoff", "catalog:cli"] : []),
          "restore", "catalog:tui",
          { launch: ["tv"], request: args[0] === "handoff" ? { source: "handoff" } : null },
        ]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the entry loads installed commands on a miss and preserves inventories, aliases and disabled plugins", async () => {
  const root = join(import.meta.dir, "../..");
  const directory = await smokeDirectory();
  const pluginDirectory = join(directory, "plugins", "startup-check");
  const marker = join(directory, "plugin-imports.txt");
  const config = createDefaultConfig(directory);
  try {
    await mkdir(pluginDirectory, { recursive: true });
    await Bun.write(join(directory, "config.json"), JSON.stringify(config));
    await Bun.write(join(pluginDirectory, "index.ts"), `
      import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(marker)}, "imported\\n");
      export default {
        id: "startup-check", name: "Startup check", version: "1.0.0",
        cliCommands: [{
          name: "startup-check", aliases: ["startup-alias"], description: "Installed startup command",
          execute: (args, ctx) => ctx.printResult({ data: { args } }),
        }],
        panes: [{ id: "startup-pane", name: "Startup pane", component: () => null, defaultPosition: "right" }],
        paneTemplates: [{
          id: "startup-template", paneId: "startup-pane", label: "Startup pane", description: "Installed startup pane",
          shortcut: { prefix: "STARTUP" }, catalogSettings: { installed: true },
        }],
      };
    `);
    const run = async (args: string[]) => {
      await rm(marker, { force: true });
      const child = Bun.spawn([process.execPath, join(root, "bin/gloom"), ...args, "--json"], {
        cwd: root, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GLOOMBERB_HOME: directory, GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [stdout, stderr, status] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        const imports = await Bun.file(marker).exists() ? (await readFile(marker, "utf8")).trim().split("\n").length : 0;
        return { stdout, stderr, status, imports };
      } finally {
        clearTimeout(timer);
      }
    };
    for (const args of [["--version"], ["quote", "--help"], ["help", "quote"], ["notes", "--help"], ["catalog", "glossary", "SOFR"]]) {
      const result = await run(args);
      expect({ args, status: result.status, stderr: result.stderr, imports: result.imports })
        .toEqual({ args, status: 0, stderr: "", imports: 0 });
    }
    for (const command of ["startup-check", "startup-alias"]) {
      const result = await run([command, "hello"]);
      expect({ status: result.status, stderr: result.stderr, imports: result.imports }).toEqual({ status: 0, stderr: "", imports: 1 });
      expect(JSON.parse(result.stdout).data).toEqual({ args: ["hello"] });
    }
    for (const args of [["help"], ["help", "startup-alias"], ["startup-check", "--help"]]) {
      const result = await run(args);
      expect({ status: result.status, stderr: result.stderr, imports: result.imports }).toEqual({ status: 0, stderr: "", imports: 1 });
      expect(result.stdout).toContain("Installed startup command");
    }
    const catalog = await run(["catalog", "STARTUP"]);
    expect({ status: catalog.status, stderr: catalog.stderr, imports: catalog.imports }).toEqual({ status: 0, stderr: "", imports: 1 });
    expect(JSON.parse(catalog.stdout).data).toContainEqual(expect.objectContaining({ token: "STARTUP", defaultSettings: { installed: true } }));
    const plugins = await run(["plugin", "list"]);
    expect({ status: plugins.status, stderr: plugins.stderr, imports: plugins.imports }).toEqual({ status: 0, stderr: "", imports: 1 });
    expect(JSON.parse(plugins.stdout).data).toContainEqual(expect.objectContaining({ id: "startup-check" }));
    const unknown = await run(["not-a-startup-command"]);
    expect({ status: unknown.status, imports: unknown.imports }).toEqual({ status: 1, imports: 1 });
    expect(JSON.parse(unknown.stderr).error.message).toContain('Unknown command "not-a-startup-command"');

    await Bun.write(join(directory, "config.json"), JSON.stringify({ ...config, disabledPlugins: ["startup-check"] }));
    const disabled = await run(["startup-check"]);
    expect({ status: disabled.status, imports: disabled.imports }).toEqual({ status: 1, imports: 1 });
    expect(JSON.parse(disabled.stderr).error.message).toContain('Unknown command "startup-check"');
    const help = await run(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain("Installed startup command");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
