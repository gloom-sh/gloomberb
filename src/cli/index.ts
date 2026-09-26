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
  type CliHelpEntry,
} from "./help";
import { parsePaneFunctionArgs } from "./pane-functions/options";
import { fail, inferCliErrorOptions, printCliError } from "./errors";
import { setCliColorEnabledOverride } from "../utils/cli-output";
import { search, searchCandidatesForCli, buildSearchReport } from "./commands/search";
import { ticker } from "./commands/ticker";
import { apiCliCommand } from "./commands/api";
import { marketDataCliCommands } from "./commands/market";
import { overviewCliCommands } from "./commands/overview";
import { remoteCliCommand } from "./commands/remote";
import { createSystemCliCommands } from "./commands/system";
import {
  brokerCliCommand,
  ibkrCliCommand,
  rssCliCommand,
} from "./commands/automation";
import {
  installPlugin,
  listPlugins,
  parseGitHubRef,
  removePlugin,
  resolveRegistryListing,
  updatePlugins,
} from "./commands/plugins";
import { requiredGloomberb } from "../utils/semver";
import { runPaneCatalog, runPaneFunction, runPaneScreenshot } from "./pane-functions";

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
        examples: ["ticker AAPL", "ticker 7203.T", "ticker AAPL --json"],
      },
      execute: async (args, ctx) => {
        const symbol = args[0];
        if (!symbol) {
          ctx.fail("Usage: gloomberb ticker <symbol>");
        }
        await ticker(symbol!, {
          initMarketData: ctx.initMarketData,
          fail: ctx.fail,
          ...(ctx.cliOptions.format === "text" ? {} : { printResult: ctx.printResult }),
        });
      },
    },
    {
      name: "catalog",
      aliases: ["functions", "capabilities"],
      description: "Find market functions to run with fn or capture with shot",
      help: {
        group: CLI_COMMAND_GROUPS.functions,
        usage: ["catalog [query] [--all] [--bot-safe]"],
        options: [
          { flags: "--all", description: "List every match instead of the first 25" },
          { flags: "--bot-safe", description: "Only functions with a verified unattended report" },
        ],
        examples: ["catalog", "catalog options", "catalog HP"],
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
        ],
        examples: [
          "fn HP AAPL",
          "fn CBR --json",
          "fn 13F AAPL --view=ticker-holdings",
          "fn OVME --spot 100 --strike 100 --days 30 --volatility 25",
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
          { flags: "--width <px>", description: "Image width, 720 to 2400 (default 1280)" },
          { flags: "--height <px>", description: "Image height, 360 to 1800 (default 720)" },
          { flags: "--theme <id>", description: "Render with another theme, such as amber or green" },
          { flags: "--scale <n>", description: "Text scale from 0.5 to 4 (default 1)" },
          { flags: "--watermark <label>", description: "Label drawn in the pane title bar" },
          { flags: "--<option> <value>", description: "A function setting; gloomberb catalog <function> lists them" },
        ],
        examples: [
          "shot TAS AAPL --output tape.png",
          "shot DDIS MSFT --tab history",
          "shot HP NVDA --width 1600 --theme green",
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
        examples: ["install gloom-sh/gloom-fear-greed", "install https://github.com/gloom-sh/gloom-tv"],
      },
      execute: async (args) => {
        const ref = args[0];
        if (!ref) {
          fail("Usage: gloomberb install <user/repo>");
        }
        // A listed plugin lands on the commit the registry reviewed, the same
        // as an install from the marketplace pane. Unlisted ones follow HEAD.
        const listing = await resolveRegistryListing(parseGitHubRef(ref).repo);
        const required = requiredGloomberb(listing?.minGloomberb);
        if (required) fail(`${ref} needs Gloomberb ${required}, this is ${VERSION}.`, "Update Gloomberb first.");
        await installPlugin(ref, listing?.pin ? { pin: listing.pin } : {});
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
    ...createSystemCliCommands(allCommands),
    brokerCliCommand,
    ibkrCliCommand,
    rssCliCommand,
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

async function createRegistry(options: DispatchCliOptions = {}): Promise<CliCommandRegistry> {
  const config = await loadCliConfigIfAvailable();
  let registry: CliCommandRegistry | null = null;
  const coreCommands = createCoreCliCommands(
    () => registry!.commands.map(({ command, source }) => ({ command, source })),
    (token) => registry!.lookup.get(normalizeCliCommandToken(token))?.command ?? null,
    () => registry!.commands.map((entry) => entry.command),
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
    printCliError(error, inferCliErrorOptions(args));
    process.exitCode = 1;
    return { kind: "handled" };
  }
  setCliColorEnabledOverride(parsed.options.color);
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
    const result = await target.command.execute(
      commandArgs,
      createCliCommandContext(target.ownerId, registry, parsed.options),
    );
    return normalizeCliDispatchResult(result);
  } catch (error) {
    printCliError(error, parsed.options, { command: resolved.command.name });
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
  return failUnknownCommand(token, registry.commands.map((entry) => entry.command));
}

export async function runCli(args: string[], options: DispatchCliOptions = {}): Promise<boolean> {
  const result = await dispatchCli(args, options);
  return result.kind === "handled";
}
