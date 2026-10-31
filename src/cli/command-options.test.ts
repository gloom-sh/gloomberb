import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCliCommandOptions, foldCommandArgs, type BuiltinCliCommandDef } from "./command-options";
import { notesCliCommand } from "../plugins/builtin/notes/cli";
import { dispatchCli } from "./index";
import { parseCliGlobalArgs } from "./options";
import { captureConsole } from "../test-support/console";
import { marketDataCliCommands } from "./commands/market";

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
    details: "history takes a --range instead of dates.\nOptions: --range, --exchange, --all. See gloom help history.",
  });
  expect(failure(() => check(history, ["AAPL", "--rnage=5Y"])).details).toContain("Did you mean --range?");
  expect(failure(() => check(history, ["AAPL", "--all=yes"])).message).toBe("--all takes no value.");
  expect(failure(() => check({ ...history, help: {} }, ["--range", "1Y"])).details).toBe("history takes no options. See gloom help history.");
  // --explain, which fn and portfolio show take, points at the glossary on a command without one.
  expect(failure(() => check(history, ["AAPL", "--explain"])).details).toStartWith(
    "--explain follows the reports of fn <function> and portfolio show. gloom catalog explain <term> prints what one term means; gloom catalog glossary lists every term.",
  );
});

test("--currency, which no command takes, names fx with the code typed", () => {
  const quote: BuiltinCliCommandDef = { ...history, name: "quote", unknownOptionHint: undefined, help: { options: [{ flags: "--exchange <code>", description: "" }] } };
  expect(failure(() => check(quote, ["SBLK", "--currency", "EUR"])).details).toStartWith(
    "Prices are in each listing's own currency. To convert an amount, use fx: gloom fx 100 USD/EUR.");
  expect(failure(() => check(quote, ["SBLK", "--ccy=gbp"])).details).toContain("gloom fx 100 USD/GBP");
});

test("financials --quarterly points at the functions that list quarters, with the symbol typed", () => {
  const financials = marketDataCliCommands.find((command) => command.name === "financials")!;
  const hint = "financials lists fiscal years. For quarters: gloom fn GF WFC --period quarterly --periods 40 (one metric at a time), "
    + "or gloom fn FA WFC --period quarterly (the statements).";
  for (const flag of ["--quarterly", "--period", "--freq"]) {
    const value = flag === "--quarterly" ? [] : ["quarterly"];
    expect(failure(() => check(financials, ["WFC", flag, ...value])).details).toStartWith(hint);
    // Before the symbol: a switch is not followed by its value, an option that takes one is.
    expect(failure(() => check(financials, [flag, ...value, "WFC"])).details).toStartWith(hint);
  }
  expect(failure(() => check(financials, ["--exchange", "NYSE", "--quarterly", "WFC"])).details).toStartWith(hint);
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
  const rejected = await captureConsole(() => dispatchCli(["history", "AAPL", "--since", "1995-01-01", "--json"]));
  expect(rejected.exitCode).toBe(1);
  expect(JSON.parse(rejected.stderr).error.message).toBe("Unknown option --since for history.");

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

test("dispatch reads full-width letters, digits and spaces as ASCII once for every command, and leaves paths as typed", async () => {
  const home = await mkdtemp(join(tmpdir(), "gloomberb-cli-options-"));
  tempDirs.push(home);
  process.env.HOME = home;
  // A plugin's command gets what every built-in gets: `quote ＧＭＥ`, `fn SIW "ＧＭＥ　AMC"`, a full-width 10 shares.
  const echo = await captureConsole(() => dispatchCli(["ｅｃｈｏ-args", "ＧＭＥ", "ＧＭＥ\u3000AMC", "１０", "--date", "２０２６年１０月１３日", "--file", "ポートフォリオ（１）.csv"], {
    externalPlugins: [{
      path: "/tmp/echo-args",
      plugin: {
        id: "echo-args", name: "Echo", version: "1.0.0",
        cliCommands: [{ name: "echo-args", description: "Echo", execute: (args) => { console.log(JSON.stringify(args)); } }],
      },
    }],
  }));
  expect(JSON.parse(echo.stdout)).toEqual(["GME", "GME AMC", "10", "--date", "2026年10月13日", "--file", "ポートフォリオ（１）.csv"]);

  // A note's text and an export's folder are kept as typed; the note's symbol is read as any other.
  expect(foldCommandArgs(notesCliCommand, ["set", "ＧＭＥ", "--exchange", "ＮＹＳＥ", "ＥＰＳ（強気）"])).toEqual(["set", "GME", "--exchange", "NYSE", "ＥＰＳ（強気）"]);
  expect(foldCommandArgs(notesCliCommand, ["export", "ノート（１）"])).toEqual(["export", "ノート（１）"]);
  // `fn` and `shot` take any option; their output path is still a path.
  expect(foldCommandArgs({ ...history, help: { options: [{ flags: "--<option> <value>", description: "" }] } }, ["ＳＩＷ", "--output=図（１）.png", "--out", "図（２）.png"]))
    .toEqual(["SIW", "--output=図（１）.png", "--out", "図（２）.png"]);
});
