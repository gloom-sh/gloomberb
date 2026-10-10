import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCliCommandOptions, type BuiltinCliCommandDef } from "./command-options";
import { dispatchCli } from "./index";
import { parseCliGlobalArgs } from "./options";
import { captureConsole } from "../test-support/console";

const history: BuiltinCliCommandDef = {
  name: "history",
  description: "History",
  help: { options: [{ flags: "--range <range>", description: "" }, { flags: "--exchange <code>", description: "" }, { flags: "--all", description: "" }] },
  unknownOptionHint: (flag) => flag === "--from" ? "history takes a --range instead of dates." : null,
  execute: () => {},
};

/** The command's arguments as the dispatcher hands them over: global flags out, `--` marking where literals start. */
function check(command: BuiltinCliCommandDef, raw: string[]): void {
  const parsed = parseCliGlobalArgs([command.name, ...raw]);
  checkCliCommandOptions(command, parsed.args.slice(1), parsed.literalStart - 1);
}

function failure(run: () => void): { message: string; details: unknown } {
  try {
    run();
  } catch (error) {
    return { message: (error as Error).message, details: (error as { details?: unknown }).details };
  }
  throw new Error("expected a failure");
}

test("declared options, their values and global flags pass; anything after -- or a negative number is not an option", () => {
  // A value-taking option consumes the next token whatever it looks like.
  check(history, ["AAPL", "--range", "--all", "--exchange=NASDAQ", "--all", "--json", "--limit", "5"]);
  check(history, ["AAPL", "--", "--from", "1995-01-01"]);
  check(history, ["-5", "---", "AAPL"]);
  check({ ...history, help: { options: [{ flags: "--<option> <value>", description: "" }] } }, ["HP", "--anything", "1"]);
});

test("an undeclared option fails with the command's options, a close match and its own hint", () => {
  expect(failure(() => check(history, ["ZAR=X", "--from", "1995-01-01"]))).toEqual({
    message: "Unknown option --from for history.",
    details: "history takes a --range instead of dates.\nOptions: --range, --exchange, --all. See gloomberb help history.",
  });
  expect(failure(() => check(history, ["AAPL", "--rnage=5Y"])).details).toContain("Did you mean --range?");
  expect(failure(() => check(history, ["AAPL", "--all=yes"])).message).toBe("--all takes no value.");
  expect(failure(() => check({ ...history, help: {} }, ["--range", "1Y"])).details).toBe("history takes no options. See gloomberb help history.");
});

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("every built-in command's own examples pass its option check", async () => {
  const home = await mkdtemp(join(tmpdir(), "gloomberb-cli-options-"));
  tempDirs.push(home);
  process.env.HOME = home;
  const { stdout } = await captureConsole(() => dispatchCli(["help", "--json"]));
  const commands = JSON.parse(stdout).data as Array<{ name: string; aliases: string[]; options: Array<{ flags: string; description: string }>; examples: string[] }>;
  expect(commands.length).toBeGreaterThan(40);
  for (const { name, aliases, options, examples } of commands) {
    const command: BuiltinCliCommandDef = { name, description: "", help: { options }, execute: () => {} };
    for (const example of examples) {
      // Quoted arguments are values, never options.
      const [token, ...args] = example.replace(/"[^"]*"/g, "VALUE").split(/\s+/).filter((part) => part !== ">" && !part.endsWith(".csv"));
      // `help` shows `quote --help`, another command's example.
      if (![name, ...aliases].includes(token!)) continue;
      expect(() => check(command, args)).not.toThrow();
    }
  }
});

test("dispatch rejects a built-in command's unknown option in the structured error form, and leaves plugin commands alone", async () => {
  const home = await mkdtemp(join(tmpdir(), "gloomberb-cli-options-"));
  tempDirs.push(home);
  process.env.HOME = home;
  const rejected = await captureConsole(() => dispatchCli(["history", "AAPL", "--from", "1995-01-01", "--json"]));
  expect(rejected.exitCode).toBe(1);
  expect(JSON.parse(rejected.stderr).error.message).toBe("Unknown option --from for history.");

  const plugin = await captureConsole(() => dispatchCli(["echo-args", "--whatever", "1"], {
    externalPlugins: [{
      path: "/tmp/echo-args",
      plugin: {
        id: "echo-args", name: "Echo", version: "1.0.0",
        cliCommands: [{ name: "echo-args", description: "Echo", execute: (args) => { console.log(args.join(" ")); } }],
      },
    }],
  }));
  expect(plugin.stdout).toContain("--whatever 1");
});
