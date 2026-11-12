import { VERSION } from "../version";
import type { CliCommandContext, CliCommandDef, CliDispatchResult, CliLaunchRequest } from "../types/plugin";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { loadCliConfigIfAvailable } from "./context";
import { checkCliOutputFormat, commandOwnsOutput, parseCliGlobalArgs, type CliGlobalOptions } from "./options";
import { checkOutputPath, resolveOutputPath, writeOutputFile } from "./output-file";
import { printCliResult, takeCliFileExport } from "./result";
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
import { checkCliCommandOptions, foldCommandArgs } from "./command-options";
import { foldTypedText } from "../utils/typed-text";
import { CLI_EXIT_CODES } from "./exit-codes";
import { asUsageError, fail, inferCliErrorOptions, printCliError } from "./errors";
import { cliStyles, setCliColorEnabledOverride, setCliPlainOverride, setCliWidthOverride } from "../utils/cli-output";
import { setDisplayTimeZone } from "../utils/utc-time";
import { collectSavedCopies } from "../data/saved-copies";
import { search, searchCandidatesForCli, buildSearchReport } from "./commands/search";
import { ticker } from "./commands/ticker";
import { requireOneArg, takeFlag, takeOption } from "./commands/command-utils";
import { EXCHANGE_OPTION } from "./listing-arg";
import { apiCliCommand } from "./commands/api";
import { marketDataCliCommands } from "./commands/market";
import { overviewCliCommands } from "./commands/overview";
import { remoteCliCommand } from "./commands/remote";
import { createSystemCliCommands } from "./commands/system";
import { brokerCliCommand, ibkrCliCommand } from "./commands/broker";
import { installedPluginArg, listPlugins, updatePlugins } from "./commands/plugins";
import { installListedPlugin, removePlugin } from "../plugins/installer";
import {
  catalogCommandHits,
  functionCodeCommand,
  nearFunctionCodeCommand,
  runPaneCatalog,
  runPaneFunction,
  runPaneFunctionHelp,
  runPaneScreenshot,
} from "./pane-functions";
import { hitsBesideNearCommand, type UnknownCommandPointers, unknownCommandReply } from "./unknown-command";
import { catalogFredSeriesIds } from "./series-search";
import { primeBoardCoins } from "./board-coins";

const { width: SHOT_WIDTH, height: SHOT_HEIGHT } = SHOT_SIZE_LIMITS;

/** The commands the CLI itself defines (help, ticker, search, ...), which plugins' commands join. */
export function createCoreCliCommands(
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
        usage: ["help [command]", "<command> --help", "help fn <function>", "fn <function> --help"],
        examples: ["help", "help quote", "quote --help", "fn BT --help"],
      },
      execute: async (args, ctx) => {
        const topic = args[0];
        if (topic) {
          const command = lookupCommand(topic);
          if (!command) failUnknownCommand(topic, allCommands(), await unknownCommandPointers(ctx, topic, [], allCommands()));
          // A command that runs a function is helped by that function's own options when one is named.
          if (FUNCTION_COMMANDS.has(command.name) && args.length > 1 && await runPaneFunctionHelp(command.name, args.slice(1), ctx)) return;
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
      description: "Open the terminal UI, like plain gloom",
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
          plugins: ctx.plugins,
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
        options: [
          EXCHANGE_OPTION,
          { flags: "--all", description: "List a bank's pricing supplements (424B2, FWP, its notes' 424B3) and the 13D/13G it filed about other companies among the recent SEC filings" },
        ],
        examples: ["ticker AAPL", "ticker SAN:EPA", "ticker 7203.T", "ticker AAPL --json"],
      },
      execute: async (rawArgs, ctx) => {
        const args = [...rawArgs];
        const exchange = takeOption(args, "--exchange");
        const allFilings = takeFlag(args, "--all");
        const symbol = requireOneArg(args, "ticker <symbol>", "symbol", ctx);
        await ticker(symbol, {
          exchange,
          allFilings,
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
          { flags: "--all", description: "List every match, not just the best ones" },
          { flags: "--bot-safe, --botsafe", description: "Only functions with a verified unattended report" },
        ],
        sections: [{
          title: "Glossary",
          lines: [
            "catalog glossary lists the rates, auction, energy, perpetual-futures, portfolio and fund terms the functions show, such as bid-to-cover, SOFR, TTF, funding rate, drift or NAV; with a term, or as catalog explain <term>, it prints what that term means. A search names the terms it matches too.",
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
          { flags: "--<option> <value>", description: "A function setting; gloom catalog <function> lists them" },
          { flags: "--require-bot-safe", description: "Fail unless the function has a verified, complete report" },
          { flags: "--explain", description: "Follow the report with what its terms mean (text and JSON; CSV keeps the rows)" },
          { flags: "--output <path>, --out <path>", description: "Write the report to this file, in the format asked for, and print where it went" },
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
          "fn WEI --csv --section europe --output europe.csv",
          "fn RV NEE,FSLR --csv --output rv.csv",
          "fn 13F AAPL --view=ticker-holdings",
          "fn OVME --spot 100 --strike 100 --days 30 --volatility 25",
          "fn HIVG SPY --event fomc --offset -6 --lookback ALL --csv",
          "fn AUCT --explain",
        ],
        sections: [{
          title: "Exit status",
          lines: [
            "0 when the report has data for what was asked, partial data with warnings about the rest included; 1 when it has none (an empty report, or rows with no value for a listing that has nothing) or the input is bad. --json ok is false exactly when the exit status is 1.",
            "CSV headers are the same for every symbol: a reason a figure is missing goes to the status column, never into a number cell.",
          ],
        }],
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
          { flags: "--theme <id>", description: "Render with another theme, such as amber or colorblind; gloom config themes lists them" },
          { flags: "--scale <n>", description: "Text scale from 0.5 to 4 (default 1)" },
          { flags: "--watermark <label>", description: "Label drawn in the pane title bar" },
          { flags: "--no-status", description: "Leave out the dated status line (as-of, delay, market hours) drawn in the pane footer" },
          { flags: "--strict", description: `Exit ${CLI_EXIT_CODES.unusableShot} when the pane is empty, shows an error, is still loading or is access-gated; the PNG and the Reason line are still written` },
          { flags: "--<option> <value>", description: "A function setting; gloom catalog <function> lists them" },
          EXCHANGE_OPTION,
        ],
        examples: [
          "shot TAS AAPL --output tape.png",
          "shot HP BHP:ASX",
          "shot DDIS MSFT --tab history",
          "shot HP NVDA --width 1600 --theme green",
          "shot QQ AAPL,MSFT --no-status",
          "shot OVDV SPY --tab term --strict --output term.png",
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
          fail("Usage: gloom install <user/repo>");
        }
        console.error(cliStyles.warning("Runs with your full permissions. Read the source first."));
        await installListedPlugin(ref);
      },
    },
    {
      name: "update",
      description: "Update installed plugins, or one by id or folder",
      help: {
        group: CLI_COMMAND_GROUPS.plugins,
        usage: ["update [plugin]"],
        sections: [{
          title: "Updating Gloom itself",
          lines: [
            "The app updates itself from stable releases. config set updates.channel nightly adds the nightly build of main; see gloom help config.",
          ],
        }],
        examples: ["update", "update tv"],
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
        usage: ["remove <plugin>"],
        examples: ["remove tv"],
      },
      execute: async (args) => {
        const name = args[0];
        if (!name) {
          fail("Usage: gloom remove <plugin>");
        }
        await removePlugin(installedPluginArg(name));
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

/** Commands whose first argument is a function, so `<command> <function> --help` is that function's help. */
const FUNCTION_COMMANDS: ReadonlySet<string> = new Set(["fn", "shot"]);

function requirePaneFunctionTarget(args: string[], commandName: string, ctx: CliCommandContext): void {
  let target: string;
  try {
    target = parsePaneFunctionArgs(args).target;
  } catch {
    // Intentional ignore: The pane function runner reports invalid options with its error code.
    return;
  }
  if (!target) ctx.fail(`Usage: gloom ${commandName} <function> [argument] [options]`);
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

function nearCommand(token: string, commands: CliCommandDef[]): string | null {
  return suggestCliCommand(
    normalizeCliCommandToken(token),
    commands.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
  );
}

/** What an unknown command word may point at: a function's code first, then what the catalog finds for it. */
async function unknownCommandPointers(
  ctx: CliCommandContext,
  token: string,
  args: readonly string[],
  commands: CliCommandDef[],
): Promise<UnknownCommandPointers> {
  const fn = await functionCodeCommand(ctx, token, args);
  const near = fn ? null : nearCommand(token, commands);
  const found = fn ? [] : await catalogCommandHits(ctx, token);
  // A word close to a command is that command's slip, unless a function is named for it: `screen` is the
  // screener before it is `screenshot` mistyped.
  const hits = hitsBesideNearCommand(found, token, near);
  // What the catalog finds for a word (`comps`) outranks the code it happens to be a slip from.
  const nearFn = fn || near || hits.length > 0 ? null : await nearFunctionCodeCommand(ctx, token, args);
  return { fn, nearFn, hits, args };
}

/** An unknown command word, answered as unknownCommandReply says. */
function failUnknownCommand(token: string, commands: CliCommandDef[], pointers: UnknownCommandPointers): never {
  const reply = unknownCommandReply(token,
    commands.map((command) => ({ name: command.name, usage: command.help?.usage ?? [] })),
    pointers, nearCommand(token, commands));
  fail(reply.message, reply.details);
}

const CLI_DESCRIPTION = "Market research and portfolio tracker for the terminal";

export interface DispatchCliOptions {
  externalPlugins?: LoadedExternalPlugin[];
  loadExternalPlugins?: () => Promise<LoadedExternalPlugin[]>;
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
    ...(options.externalPlugins === undefined ? { loadExternalPlugins: options.loadExternalPlugins } : {}),
    config,
  });
  return registry;
}

export { buildSearchReport, searchCandidatesForCli };

export async function dispatchCli(args: string[], options: DispatchCliOptions = {}): Promise<CliDispatchResult> {
  let parsed;
  try {
    // --output without a format is refused once the command is known: a plugin's own --output is not the export's.
    parsed = parseCliGlobalArgs(args, { deferOutputCheck: true });
  } catch (error) {
    printCliError(asUsageError(error), inferCliErrorOptions(args));
    process.exitCode = 1;
    return { kind: "handled" };
  }
  setCliColorEnabledOverride(parsed.options.color);
  setCliWidthOverride(parsed.options.width ?? null);
  // The CLI entry sets plain output for a pipe or NO_COLOR (entry.ts); `--plain` and `--no-plain` decide it either way.
  if (parsed.options.plain != null) setCliPlainOverride(parsed.options.plain);
  const command = parsed.args[0] ?? (parsed.help ? "help" : undefined);
  if (!command) {
    return { kind: "unhandled" };
  }

  const registry = await createRegistry(options);
  const token = normalizeCliCommandToken(foldTypedText(command));
  let resolved = registry.lookup.get(token);
  if (!resolved) {
    await registry.ensureExternalPlugins?.();
    resolved = registry.lookup.get(token);
  }
  if (!resolved) {
    return { kind: "unhandled" };
  }
  try {
    // A plugin command with its own --output keeps it: the global flag yields, as it does to `fn` and `shot`.
    if (parsed.options.output !== undefined && commandOwnsOutput(resolved.command)) parsed = parseCliGlobalArgs(args, { ownsOutput: true });
    checkCliOutputFormat(parsed);
  } catch (error) {
    printCliError(asUsageError(error), parsed.options);
    process.exitCode = 1;
    return { kind: "handled" };
  }

  // The overview includes installed commands; one built-in command's help only
  // needs that command. An unknown help topic may belong to an installed plugin.
  if (resolved.command.name === "help") {
    const topic = parsed.args[1];
    if (!topic || !registry.lookup.has(normalizeCliCommandToken(foldTypedText(topic)))) {
      await registry.ensureExternalPlugins?.();
    }
  }

  // Help flags never reach the command, where they would read as a symbol, a
  // plugin name, or a note to write.
  const helpOnly = parsed.help && resolved.command.name !== "help";
  const target = helpOnly ? registry.lookup.get("help")! : resolved;
  // The words after a command that runs a function name the function whose help it is (`fn BT --help`).
  // Full-width letters and digits (ＧＭＥ, １０) are read as the ASCII they stand for, once, here.
  const commandArgs = helpOnly
    ? [resolved.command.name, ...FUNCTION_COMMANDS.has(resolved.command.name) ? foldCommandArgs(resolved.command, parsed.args.slice(1)) : []]
    : foldCommandArgs(resolved.command, parsed.args.slice(1), parsed.literalStart - 1);
  try {
    if (!helpOnly && resolved.builtin) checkCliCommandOptions(resolved.command, commandArgs, parsed.literalStart - 1);
    // The file --output names, checked before the command runs so a path that cannot be written fails at once.
    const outputPath = parsed.options.output !== undefined && !helpOnly ? resolveOutputPath(parsed.options.output) : null;
    const replacing = outputPath ? await checkOutputPath(outputPath) : false;
    takeCliFileExport();
    // What it answers from a saved copy, its refresh having failed, its closing line says.
    const result = await collectSavedCopies(() => Promise.resolve(target.command.execute(
      commandArgs,
      createCliCommandContext(target.ownerId, registry, parsed.options, commandArgs),
    )));
    if (outputPath) await saveFileExport(outputPath, parsed.options, resolved.command.name, replacing);
    return normalizeCliDispatchResult(result);
  } catch (error) {
    takeCliFileExport();
    // A coin typed without its quote currency (USDT) is named by its one symbol (USDT-USD) in the hint.
    if (parsed.options.format !== "json") await primeBoardCoins([error instanceof Error ? error.message : String(error)]);
    printCliError(error, parsed.options, { command: resolved.command.name, args: commandArgs,
      isFredSeries: (id) => catalogFredSeriesIds(registry.plugins).has(id) });
    process.exitCode = 1;
    return { kind: "handled" };
  }
}

/**
 * Writes the export a command printed to the file `--output` named, in
 * UTF-8 without a byte order mark, and says where it went: `Saved <path>`,
 * `Replaced <path>` over a file that was there, or in JSON its envelope. A
 * command that printed no export (its result failed, or it has no table to
 * export) writes no file and says so.
 */
async function saveFileExport(path: string, options: CliGlobalOptions, command: string, replacing: boolean): Promise<void> {
  const written = takeCliFileExport();
  if (written === null) {
    if (process.exitCode) return;
    throw new Error(`${command} printed no ${options.format.toUpperCase()} export; nothing was written to ${path}.`);
  }
  await writeOutputFile(path, `${written}\n`);
  printCliResult({ data: { output: path, format: options.format, replaced: replacing } },
    { ...options, output: undefined, format: options.format === "json" ? "json" : "text" },
    { text: () => `${replacing ? "Replaced" : "Saved"} ${path}` });
}

/** Explains why dispatch found no command in `args`, suggesting the closest one. */
export async function failUnknownCliCommand(args: string[], options: DispatchCliOptions = {}): Promise<never> {
  let token = args[0] ?? "";
  let parsed: ReturnType<typeof parseCliGlobalArgs> | null = null;
  try {
    // Global flags may come first, so name the token dispatch actually looked up.
    parsed = parseCliGlobalArgs(args);
    token = parsed.args[0] ?? token;
  } catch {
    // Intentional ignore: dispatchCli already reports invalid flags.
  }
  const registry = await createRegistry(options);
  await registry.ensureExternalPlugins?.();
  const commands = listedCommands(registry).map((entry) => entry.command);
  // A function's code typed as a command is pointed at `fn`, and a word the catalog knows at its
  // functions, with the arguments the reader gave.
  const pointers = token && parsed
    ? await unknownCommandPointers(createCliCommandContext("core", registry, parsed.options, parsed.args.slice(1)), token, parsed.args.slice(1), commands)
    : { fn: null, nearFn: null, hits: [], args: [] };
  return failUnknownCommand(token, commands, pointers);
}

export async function runCli(args: string[], options: DispatchCliOptions = {}): Promise<boolean> {
  const result = await dispatchCli(args, options);
  return result.kind === "handled";
}
