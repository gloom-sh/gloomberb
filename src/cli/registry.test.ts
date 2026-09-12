import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createDefaultConfig } from "../types/config";
import type { GloomPlugin } from "../types/plugin";
import {
  buildCliCommandRegistry,
  createCliCommandContext,
  normalizeCliCommandToken,
  renderCliHelp,
} from "./registry";
import { dispatchCli } from "./index";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempHome(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(String(chunk).replace(/\n$/, ""));
    return true;
  });

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const result = await fn();
    return {
      result,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    stdout.mockRestore();
  }
}

function createSyntheticPlugin(commandName = "example"): GloomPlugin {
  return {
    id: "synthetic-cli",
    name: "Synthetic CLI",
    version: "1.0.0",
    cliCommands: [{
      name: commandName,
      aliases: ["alias-example"],
      description: "Synthetic plugin command",
      help: {
        usage: [`${commandName} [value]`],
        sections: [{
          title: "Synthetic Help",
          lines: ["Hello from the synthetic plugin."],
        }],
      },
      execute: async (args, ctx) => {
        console.log(`${ctx.log ? "ok" : "missing"}:${args.join(" ")}`);
      },
    }],
  };
}

describe("CLI registry", () => {
  test("indexes plugin commands and aliases from the registry", () => {
    const registry = buildCliCommandRegistry({
      coreCommands: [],
      externalPlugins: [{
        plugin: createSyntheticPlugin(),
        path: "/tmp/synthetic-cli",
      }],
      config: null,
    });

    expect(registry.lookup.get(normalizeCliCommandToken("example"))?.ownerId).toBe("synthetic-cli");
    expect(registry.lookup.get(normalizeCliCommandToken("alias-example"))?.ownerId).toBe("synthetic-cli");
  });

  test("renders a plugin command's usage and help sections in the CLI help", () => {
    const registry = buildCliCommandRegistry({
      coreCommands: [],
      externalPlugins: [{
        plugin: createSyntheticPlugin(),
        path: "/tmp/synthetic-cli",
      }],
      config: null,
    });

    const help = renderCliHelp(registry, "0.0.0");

    expect(help).toContain("example [value]");
    expect(help).toContain("Synthetic Help");
    expect(help).toContain("Hello from the synthetic plugin.");
  });

  test("rejects duplicate command names and aliases", () => {
    expect(() => buildCliCommandRegistry({
      coreCommands: [{
        name: "duplicate",
        description: "Core command",
        execute: async () => {},
      }],
      externalPlugins: [{
        plugin: {
          id: "dup-plugin",
          name: "Duplicate",
          version: "1.0.0",
          cliCommands: [{
            name: "other",
            aliases: ["duplicate"],
            description: "Plugin command",
            execute: async () => {},
          }],
        },
        path: "/tmp/dup-plugin",
      }],
      config: null,
    })).toThrow(/duplicate/i);
  });

  test("omits disabled plugin commands from help and dispatch lookup", () => {
    const config = createDefaultConfig("/tmp/gloomberb-cli-disabled");
    config.disabledPlugins = ["synthetic-cli"];

    const registry = buildCliCommandRegistry({
      coreCommands: [],
      externalPlugins: [{
        plugin: createSyntheticPlugin(),
        path: "/tmp/synthetic-cli",
      }],
      config,
    });

    expect(registry.lookup.get("example")).toBeUndefined();
    expect(renderCliHelp(registry, "0.0.0")).not.toContain("Synthetic plugin command");
  });

  test("ignores broken external plugins while keeping other commands available", () => {
    const registry = buildCliCommandRegistry({
      coreCommands: [{
        name: "core-only",
        description: "Core command",
        execute: async () => {},
      }],
      externalPlugins: [{
        plugin: {
          id: "broken",
          name: "Broken Plugin",
          version: "0.0.0",
        },
        path: "/tmp/broken",
        error: "Failed to load plugin",
      }],
      config: null,
    });

    expect(registry.lookup.get("core-only")?.ownerId).toBe("core");
    expect(registry.lookup.get("broken")).toBeUndefined();
    expect(registry.commands.some((entry) => entry.ownerId === "core")).toBe(true);
  });

  test("creates plugin-scoped command contexts", async () => {
    const context = createCliCommandContext("synthetic-cli", [createSyntheticPlugin()]);
    expect(context.log).toBeDefined();
    expect(context.output.renderSection("Test")).toContain("Test");
  });
});

describe("CLI dispatch", () => {
  test("dispatches a synthetic plugin command without main CLI changes", async () => {
    process.env.HOME = await createTempHome("gloomberb-cli-registry-home-");

    const { result, stdout } = await captureConsole(() => dispatchCli(
      ["example", "hello", "world"],
      {
        externalPlugins: [{
          plugin: createSyntheticPlugin(),
          path: "/tmp/synthetic-cli",
        }],
      },
    ));

    expect(result).toEqual({ kind: "handled" });
    expect(stdout).toContain("ok:hello world");
  });

  test("renders plugin command failures through structured output", async () => {
    process.env.HOME = await createTempHome("gloomberb-cli-registry-failure-home-");
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { result, stderr } = await captureConsole(() => dispatchCli(
        ["fail-example", "--json"],
        {
          externalPlugins: [{
            plugin: {
              id: "failing-cli",
              name: "Failing CLI",
              version: "1.0.0",
              cliCommands: [{
                name: "fail-example",
                description: "Fail on purpose",
                execute: (_args, ctx) => ctx.fail("Synthetic failure.", "Synthetic details."),
              }],
            },
            path: "/tmp/failing-cli",
          }],
        },
      ));

      expect(result).toEqual({ kind: "handled" });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(stderr)).toEqual({
        ok: false,
        error: {
          code: "cli_error",
          message: "Synthetic failure.",
          details: "Synthetic details.",
        },
      });
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
  });
});
