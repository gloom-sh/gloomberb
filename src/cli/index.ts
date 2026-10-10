import { VERSION } from "../version";
import type { CliCommandContext, CliCommandDef, CliDispatchResult, CliLaunchRequest } from "../types/plugin";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { loadCliConfigIfAvailable } from "./context";
import { parseCliGlobalArgs } from "./options";
import {
  buildCliCommandRegistry,
  createCliCommandContext,
  normalizeCliCommandToken,
  normalizeCliDispatchResult,
  type CliCommandRegistry,
} from "./registry";
import {
  CLI_COMMAND_GROUPS,
  describeCliCommand,
  renderCliHelp,
  renderCommandHelp,
  suggestCliCommand,
  TABLE_SECTION_OPTION,
  type CliHelpEntry,
} from "./help";
import { parsePaneFunctionArgs, SHOT_SIZE_LIMITS } from "./pane-functions/options";
import { checkCliCommandOptions } from "./command-options";
import { asUsageError, fail, inferCliErrorOptions, printCliError } from "./errors";
import { setCliColorEnabledOverride, setCliWidthOverride } from "../utils/cli-output";
import { setDisplayTimeZone } from "../utils/utc-time";
import { search, searchCandidatesForCli, buildSearchReport } from "./commands/search";
import { ticker } from "./commands/ticker";
import { requireOneArg, takeOption } from "./commands/command-utils";
import { EXCHANGE_OPTION } from "./listing-arg";
import { apiCliCommand } from "./commands/api";
import { marketDataCliCommands } from "./commands/market";
import { overviewCliCommands } from "./commands/overview";
import { remoteCliCommand } from "./commands/remote";
import { createSystemCliCommands } from "./commands/system";
import { brokerCliCommand, ibkrCliCommand } from "./commands/broker";
import { listPlugins, updatePlugins } from "./commands/plugins";
import { installListedPlugin, removePlugin } from "../plugins/installer";
import { runPaneCatalog, runPaneFunction, runPaneScreenshot } from "./pane-functions";

const { width: SHOT_WIDTH, height: SHOT_HEIGHT } = SHOT_SIZE_LIMITS;

function createCoreCliCommands(
  helpEntries: () => CliHelpEntry[],
  lookupCommand: (token: string) => CliCommandDef | null,
  allCommands: () => CliCommandDef[],
): CliCommandDef[] {
  const launchUiRequest: CliLaunchRequest = {
    applyConfig: (config) => ({ config }),
  };
  return [
    {
      name: "help",
      aliases: ["command", "commands"],
      description: "Show every command, or the usage, options, and examples for one",
      help: {
        group: CLI_COMMAND_GROUPS.app,
        usage: ["help [command]", "<command> --help"],
        examples: ["help", "help quote", "quote --help"],
      },
      execute: (args, ctx) => {
        const topic = args[0];
        if (topic) {
          const command = lookupCommand(topic);
          if (!command) failUnknownCommand(topic, allCommands());
          printCommandHelp(command, ctx);
          return;
        }
        if (ctx.cliOptions.format === "text") {
          printHelpText(renderCliHelp(helpEntries(), VERSION, CLI_DESCRIPTION), ctx);
          return;
        }
        ctx.printResult({ data: allCommands().map(describeCliCommand) });
      },
    },
    {
      name: "launch-ui",
      aliases: ["ui"],
      description: "Open the terminal UI, like plain gloomberb",
      help: {
        group: CLI_COMMAND_GROUPS.app,
        usage: ["launch-ui"],
      },
      execute: () => ({ kind: "launch-ui", request: launchUiRequest }),
    },
    {
      name: "search",
      description: "Search tickers and company names",
      help: {
        group: CLI_COMMAND_GROUPS.research,
        usage: ["search <query>"],
        examples: ["search nvidia", "search \"berkshire hathaway\""],
      },
      execute: async (args, ctx) => {
        const query = args.join(" ");
        await search(query, {
          initMarketData: ctx.initMarketData,
          fail: ctx.fail,
          ...(ctx.cliOptions.format === "text" ? {} : { printResult: ctx.printResult }),
        });
      },
    },
    {
      name: "ticker",
      description: "Show the full research report for one symbol",
      help: {
        group: CLI_COMMAND_GROUPS.research,
        usage: ["ticker <symbol>"],
        options: [EXCHANGE_OPTION],
        examples: ["ticker AAPL", "ticker SAN:EPA", "ticker 7203.T", "ticker AAPL --json"],
      },
      execute: async (rawArgs, ctx) => {
        const args = [...rawArgs];
        const exchange = takeOption(args, "--exchange");
        const symbol = requireOneArg(args, "ticker <symbol>", "symbol", ctx);
        await ticker(symbol, {
          exchange,
          initMarketData: ctx.initMarketData,
          fail: ctx.fail,
          ...(ctx.cliOptions.format === "text" ? {} : { printResult: ctx.printResult }),
        });
      },
    },
    {
      name: "catalog",
      aliases: ["functions", "capabilities"],
      description: "Find market functions to run with fn or capture with shot, or look up a term",
      help: {
        group: CLI_COMMAND_GROUPS.functions,
        usage: ["catalog [query] [--all] [--bot-safe]", "catalog glossary [term]", "catalog explain <term>"],
        options: [
          { flags: "--all", description: "List every match instead of the first 25" },
          { flags: "--bot-safe, --botsafe", description: "Only functions with a verified unattended report" },
        ],
        sections: [{
          title: "Glossary",
          lines: [
            "catalog glossary lists the rates and auction terms the functions show, such as bid-to-cover or SOFR; with a term, or as catalog explain <term>, it prints what that term means. A search names the terms it matches too.",
          ],
        }],
        examples: ["catalog", "catalog options", "catalog HP", "catalog glossary stop-out"],
      },
      execute: async (args, ctx) => {
        await runPaneCatalog(args, ctx);
      },
    },
    {
      name: "fn",
      aliases: ["function"],
      description: "Run a market function and print its report",
      help: {
        group: CLI_COMMAND_GROUPS.functions,
        usage: ["fn <function> [argument] [options]"],
        options: [
          { flags: "--<option> <value>", description: "A function setting; gloomberb catalog <function> lists them" },
          { flags: "--require-bot-safe", description: "Fail unless the function has a verified, complete report" },
          { flags: "--explain", description: "Follow the report with what its terms mean (text and JSON; CSV keeps the rows)" },
          {
            ...TABLE_SECTION_OPTION,
            description: `${TABLE_SECTION_OPTION.description} (CALLS keeps --section for the transcript part)`,
          },
          EXCHANGE_OPTION,
        ],
        examples: [
          "fn HP AAPL",
          "fn ANR SAN:EPA",
          "fn CBR --json",
          "fn WEI --csv --section europe > europe.csv",
          "fn 13F AAPL --view=ticker-holdings",
          "fn OVME --spot 100 --strike 100 --days 30 --volatility 25",
          "fn AUCT --explain",
        ],
      },
      execute: async (args, ctx) => {
        requirePaneFunctionTarget(args, "fn", ctx);
        await runPaneFunction(args, ctx);
      },
    },
    {
      name: "shot",
      aliases: ["screenshot"],
      description: "Save a desktop-style PNG of a market function",
      help: {
        group: CLI_COMMAND_GROUPS.functions,
        usage: ["shot <function> [argument] [options]"],
        options: [
          { flags: "--output <path>", description: "PNG to write; defaults to gloomberb-<function>-<argument>.png in this folder" },
          { flags: "--width <px>", description: `Layout width, ${SHOT_WIDTH.min} to ${SHOT_WIDTH.max} (default 1280). The PNG is drawn at twice the size: ${SHOT_WIDTH.min * 2} to ${SHOT_WIDTH.max * 2} px wide` },
          { flags: "--height <px>", description: `Layout height, ${SHOT_HEIGHT.min} to ${SHOT_HEIGHT.max} (default 720), so ${SHOT_HEIGHT.min * 2} to ${SHOT_HEIGHT.max * 2} px tall` },
          { flags: "--theme <id>", description: "Render with another theme, such as amber or colorblind; gloomberb config themes lists them" },
          { flags: "--scale <n>", description: "Text scale from 0.5 to 4 (default 1)" },
          { flags: "--watermark <label>", description: "Label drawn in the pane title bar" },
          { flags: "--no-status", description: "Leave out the dated status line (as-of, delay, market hours) drawn in the pane footer" },
          { flags: "--<option> <value>", description: "A function setting; gloomberb catalog <function> lists them" },
          EXCHANGE_OPTION,
        ],
        examples: [
          "shot TAS AAPL --output tape.png",
          "shot HP BHP:ASX",
          "shot DDIS MSFT --tab history",
          "shot HP NVDA --width 1600 --theme green",
          "shot QQ AAPL,MSFT --no-status",
        ],
      },
      execute: async (args, ctx) => {
        requirePaneFunctionTarget(args, "shot", ctx);
        await runPaneScreenshot(args, ctx);
      },
    },
    {
      name: "plugins",
      aliases: ["list"],
      description: "List plugins installed from GitHub",
      help: {
        group: CLI_COMMAND_GROUPS.plugins,
        usage: ["plugins [--check]"],
        options: [
          { flags: "--check", description: "Ask each plugin's remote whether an update is waiting" },
        ],
      },
      execute: async (args, ctx) => {
        await listPlugins(ctx, { check: args.includes("--check") });
      },
    },
    {
      name: "install",
      description: "Install a plugin from GitHub",
      help: {
        group: CLI_COMMAND_GROUPS.plugins,
        usage: ["install <user/repo>"],
        examples: ["install gloom-sh/gloom-polls", "install https://github.com/gloom-sh/gloom-tv"],
      },
      execute: async (args) => {
        const ref = args[0];
        if (!ref) {
          fail("Usage: gloomberb install <user/repo>");
        }
        await installListedPlugin(ref);
      },
    },
    {
      name: "update",
      description: "Update installed plugins, or one by name",
      help: {
        group: CLI_COMMAND_GROUPS.plugins,
        usage: ["update [name]"],
        examples: ["update", "update gloom-tv"],
      },
      execute: async (args) => {
        await updatePlugins(args[0]);
      },
    },
    {
      name: "remove",
      aliases: ["uninstall"],
      description: "Remove an installed plugin",
      help: {
        group: CLI_COMMAND_GROUPS.plugins,
        usage: ["remove <name>"],
        examples: ["remove gloom-tv"],
      },
      execute: async (args) => {
        const name = args[0];
        if (!name) {
          fail("Usage: gloomberb remove <name>");
        }
        await removePlugin(name);
      },
    },
    apiCliCommand,
    ...marketDataCliCommands,
    ...overviewCliCommands,
    remoteCliCommand,
    ...createSystemCliCommands(),
    brokerCliCommand,
    ibkrCliCommand,
  ];
}

function requirePaneFunctionTarget(args: string[], commandName: string, ctx: CliCommandContext): void {
  let target: string;
  try {
    target = parsePaneFunctionArgs(args).target;
  } catch {
    // Invalid options are reported by the runner, with its error code.
    return;
  }
  if (!target) ctx.fail(`Usage: gloomberb ${commandName} <function> [argument] [options]`);
}

function printHelpText(text: string, ctx: CliCommandContext): void {
  if (!ctx.cliOptions.quiet) process.stdout.write(`${text}\n`);
}

function printCommandHelp(command: CliCommandDef, ctx: CliCommandContext): void {
  if (ctx.cliOptions.format === "text") {
    printHelpText(renderCommandHelp(command), ctx);
    return;
  }
  ctx.printResult({ data: { ...describeCliCommand(command), sections: command.help?.sections ?? [] } });
}

function failUnknownCommand(token: string, commands: CliCommandDef[]): never {
  const suggestion = suggestCliCommand(
    normalizeCliCommandToken(token),
    commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  );
  fail(
    `Unknown command "${token}".`,
    suggestion
      ? `Did you mean ${suggestion}? Run gloomberb help to see every command.`
      : "Run gloomberb help to see every command.",
  );
}

const CLI_DESCRIPTION = "Market research and portfolio tracker for the terminal";

export interface DispatchCliOptions {
  externalPlugins?: LoadedExternalPlugin[];
}

/** Old names kept so existing scripts still run; help and suggestions leave them out. */
const UNLISTED_COMMANDS: ReadonlySet<CliCommandDef> = new Set([ibkrCliCommand]);

function listedCommands(registry: CliCommandRegistry) {
  return registry.commands.filter(({ command }) => !UNLISTED_COMMANDS.has(command));
}

async function createRegistry(options: DispatchCliOptions = {}): Promise<CliCommandRegistry> {
  const config = await loadCliConfigIfAvailable();
  // Every time a command prints follows the reader's zone from here on.
  setDisplayTimeZone(config?.timezone);
  let registry: CliCommandRegistry | null = null;
  const coreCommands = createCoreCliCommands(
    () => listedCommands(registry!).map(({ command, source }) => ({ command, source })),
    (token) => registry!.lookup.get(normalizeCliCommandToken(token))?.command ?? null,
    () => listedCommands(registry!).map((entry) => entry.command),
  );
  registry = buildCliCommandRegistry({
    coreCommands,
    externalPlugins: options.externalPlugins ?? [],
    config,
  });
  return registry;
}

export { buildSearchReport, searchCandidatesForCli };

export async function dispatchCli(args: string[], options: DispatchCliOptions = {}): Promise<CliDispatchResult> {
  let parsed;
  try {
    parsed = parseCliGlobalArgs(args);
  } catch (error) {
    printCliError(asUsageError(error), inferCliErrorOptions(args));
    process.exitCode = 1;
    return { kind: "handled" };
  }
  setCliColorEnabledOverride(parsed.options.color);
  setCliWidthOverride(parsed.options.width ?? null);
  const command = parsed.args[0] ?? (parsed.help ? "help" : undefined);
  if (!command) {
    return { kind: "unhandled" };
  }

  const registry = await createRegistry(options);
  const resolved = registry.lookup.get(normalizeCliCommandToken(command));
  if (!resolved) {
    return { kind: "unhandled" };
  }

  // Help flags never reach the command, where they would read as a symbol, a
  // plugin name, or a note to write.
  const helpOnly = parsed.help && resolved.command.name !== "help";
  const target = helpOnly ? registry.lookup.get("help")! : resolved;
  const commandArgs = helpOnly ? [resolved.command.name] : parsed.args.slice(1);
  try {
    if (!helpOnly && resolved.builtin) checkCliCommandOptions(resolved.command, commandArgs, parsed.literalStart - 1);
    const result = await target.command.execute(
      commandArgs,
      createCliCommandContext(target.ownerId, registry, parsed.options, commandArgs),
    );
    return normalizeCliDispatchResult(result);
  } catch (error) {
    printCliError(error, parsed.options, { command: resolved.command.name, args: commandArgs });
    process.exitCode = 1;
    return { kind: "handled" };
  }
}

/** Explains why dispatch found no command in `args`, suggesting the closest one. */
export async function failUnknownCliCommand(args: string[], options: DispatchCliOptions = {}): Promise<never> {
  let token = args[0] ?? "";
  try {
    // Global flags may come first, so name the token dispatch actually looked up.
    token = parseCliGlobalArgs(args).args[0] ?? token;
  } catch {
    // dispatchCli already reported flags that do not parse.
  }
  const registry = await createRegistry(options);
  return failUnknownCommand(token, listedCommands(registry).map((entry) => entry.command));
}

export async function runCli(args: string[], options: DispatchCliOptions = {}): Promise<boolean> {
  const result = await dispatchCli(args, options);
  return result.kind === "handled";
}
