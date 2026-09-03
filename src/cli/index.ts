import { VERSION } from "../version";
import type { CliCommandDef, CliDispatchResult, CliLaunchRequest } from "../types/plugin";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { loadCliConfigIfAvailable } from "./context";
import { parseCliGlobalArgs } from "./options";
import {
  buildCliCommandRegistry,
  createCliCommandContext,
  normalizeCliCommandToken,
  normalizeCliDispatchResult,
  renderCliHelp,
  type CliCommandRegistry,
} from "./registry";
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
  aiCliCommand,
  brokerCliCommand,
  ibkrCliCommand,
  rssCliCommand,
} from "./commands/automation";
import {
  installPlugin,
  listPlugins,
  removePlugin,
  updatePlugins,
} from "./commands/plugins";
import { runPaneCatalog, runPaneFunction, runPaneScreenshot } from "./pane-functions";

function createCoreCliCommands(
  renderHelp: () => string,
  allCommands: () => CliCommandDef[],
): CliCommandDef[] {
  let commands: CliCommandDef[] = [];
  const launchUiRequest: CliLaunchRequest = {
    applyConfig: (config) => ({ config }),
  };
  commands = [
    {
      name: "help",
      aliases: ["--help", "-h"],
      description: "Show this help message",
      help: {
        usage: ["help"],
      },
      execute: (_args, ctx) => {
        if (ctx.cliOptions.format === "text") {
          console.log(renderHelp());
          return;
        }
        ctx.printResult({ data: allCommands().map((command) => ({
          name: command.name,
          aliases: command.aliases ?? [],
          description: command.description,
          usage: command.help?.usage ?? [],
        })) });
      },
    },
    {
      name: "launch-ui",
      aliases: ["ui"],
      description: "Launch the terminal UI explicitly",
      help: {
        usage: ["launch-ui"],
      },
      execute: () => ({ kind: "launch-ui", request: launchUiRequest }),
    },
    {
      name: "search",
      description: "Search tickers and company names",
      help: {
        usage: ["search <query>"],
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
      description: "Show quote, ownership, and detailed financials",
      help: {
        usage: ["ticker <symbol>"],
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
      name: "fn",
      aliases: ["function"],
      description: "Run a pane-backed market function and print a human-readable report",
      help: {
        usage: ["fn <function-or-pane> [argument] [--key value]"],
      },
      execute: async (args, ctx) => {
        await runPaneFunction(args, ctx);
      },
    },
    {
      name: "shot",
      aliases: ["screenshot"],
      description: "Render a desktop-style screenshot for a pane-backed market function",
      help: {
        usage: ["shot <function-or-pane> [argument] [--output path] [--width px] [--height px] [--theme id] [--key value]"],
      },
      execute: async (args, ctx) => {
        await runPaneScreenshot(args, ctx);
      },
    },
    {
      name: "catalog",
      aliases: ["functions", "capabilities"],
      description: "List searchable pane-backed market functions and screenshots",
      help: {
        usage: ["catalog [query] [--limit n] [--all]"],
      },
      execute: async (args, ctx) => {
        await runPaneCatalog(args, ctx);
      },
    },
    {
      name: "install",
      description: "Install a plugin from GitHub",
      help: {
        usage: ["install <user/repo>"],
      },
      execute: async (args) => {
        const ref = args[0];
        if (!ref) {
          fail("Usage: gloomberb install <github-user/repo>");
        }
        await installPlugin(ref);
      },
    },
    {
      name: "remove",
      aliases: ["uninstall"],
      description: "Remove an installed plugin",
      help: {
        usage: ["remove <name>"],
      },
      execute: async (args) => {
        const name = args[0];
        if (!name) {
          fail("Usage: gloomberb remove <plugin-name>");
        }
        await removePlugin(name);
      },
    },
    {
      name: "update",
      description: "Update plugins",
      help: {
        usage: ["update [name]"],
      },
      execute: async (args) => {
        await updatePlugins(args[0]);
      },
    },
    {
      name: "plugins",
      aliases: ["list"],
      description: "List installed plugins",
      help: {
        usage: ["plugins"],
      },
      execute: () => {
        listPlugins();
      },
    },
    apiCliCommand,
    ...marketDataCliCommands,
    ...overviewCliCommands,
    remoteCliCommand,
    ...createSystemCliCommands(allCommands),
    brokerCliCommand,
    ibkrCliCommand,
    aiCliCommand,
    rssCliCommand,
  ];
  return commands;
}

export interface DispatchCliOptions {
  externalPlugins?: LoadedExternalPlugin[];
}

async function createRegistry(options: DispatchCliOptions = {}): Promise<CliCommandRegistry> {
  const config = await loadCliConfigIfAvailable();
  let registry: CliCommandRegistry | null = null;
  const coreCommands = createCoreCliCommands(
    () => renderCliHelp(registry!, VERSION),
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
  const command = parsed.args[0];
  if (!command) {
    return { kind: "unhandled" };
  }

  const registry = await createRegistry(options);
  const resolved = registry.lookup.get(normalizeCliCommandToken(command));
  if (!resolved) {
    return { kind: "unhandled" };
  }

  try {
    const result = await resolved.command.execute(
      parsed.args.slice(1),
      createCliCommandContext(resolved.ownerId, registry, parsed.options),
    );
    return normalizeCliDispatchResult(result);
  } catch (error) {
    printCliError(error, parsed.options);
    process.exitCode = 1;
    return { kind: "handled" };
  }
}

export async function runCli(args: string[], options: DispatchCliOptions = {}): Promise<boolean> {
  const result = await dispatchCli(args, options);
  return result.kind === "handled";
}
