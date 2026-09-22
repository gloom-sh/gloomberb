import type { AppConfig } from "../types/config";
import type {
  CliCommandContext,
  CliCommandDef,
  CliDispatchResult,
  GloomPlugin,
} from "../types/plugin";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { getPluginCatalog } from "../plugins/catalog";
import { initCliServices, initConfigData, initMarketData } from "./context";
import { closeAndFail, fail } from "./errors";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "./options";
import { printCliResult } from "./result";
import {
  cliStyles,
  colorBySign,
  renderSection,
  renderStat,
  renderStats,
  renderTable,
} from "../utils/cli-output";
import { debugLog } from "../utils/debug-log";

const registryLog = debugLog.createLogger("cli-registry");

interface RegisteredCliCommand {
  command: CliCommandDef;
  ownerId: string;
  source: "core" | "plugin";
}

export interface CliCommandRegistry {
  commands: RegisteredCliCommand[];
  lookup: ReadonlyMap<string, RegisteredCliCommand>;
  config: AppConfig | null;
  plugins: GloomPlugin[];
  externalPlugins: LoadedExternalPlugin[];
}

interface BuildCliCommandRegistryOptions {
  coreCommands: CliCommandDef[];
  externalPlugins?: LoadedExternalPlugin[];
  config?: AppConfig | null;
}

export function normalizeCliCommandToken(token: string): string {
  return token.trim().toLowerCase();
}

function describeCommandOwner(ownerId: string, source: "core" | "plugin"): string {
  return source === "core" ? `core CLI (${ownerId})` : `plugin "${ownerId}"`;
}

function validateCommandToken(token: string, ownerId: string, source: "core" | "plugin"): string {
  const normalized = normalizeCliCommandToken(token);
  if (!normalized) {
    throw new Error(`CLI command token for ${describeCommandOwner(ownerId, source)} cannot be empty.`);
  }
  return normalized;
}

export function normalizeCliDispatchResult(result: void | CliDispatchResult): CliDispatchResult {
  if (!result) {
    return { kind: "handled" };
  }
  return result;
}

export function buildCliCommandRegistry({
  coreCommands,
  externalPlugins = [],
  config = null,
}: BuildCliCommandRegistryOptions): CliCommandRegistry {
  const allCommands: RegisteredCliCommand[] = [];
  const allTokens = new Map<string, RegisteredCliCommand>();
  const catalog = getPluginCatalog(externalPlugins);
  const disabledPlugins = new Set(config?.disabledPlugins ?? []);

  const registerCommand = (
    command: CliCommandDef,
    ownerId: string,
    source: "core" | "plugin",
  ) => {
    const tokens = new Set([
      validateCommandToken(command.name, ownerId, source),
      ...(command.aliases ?? []).map((alias) => validateCommandToken(alias, ownerId, source)),
    ]);

    for (const token of tokens) {
      const existing = allTokens.get(token);
      if (!existing) continue;
      throw new Error(
        `CLI command token "${token}" is declared by both `
        + `${describeCommandOwner(existing.ownerId, existing.source)} and ${describeCommandOwner(ownerId, source)}.`,
      );
    }

    const entry: RegisteredCliCommand = { command, ownerId, source };
    allCommands.push(entry);
    for (const token of tokens) {
      allTokens.set(token, entry);
    }
  };

  for (const command of coreCommands) {
    registerCommand(command, "core", "core");
  }

  const loadablePlugins: GloomPlugin[] = [];
  for (const entry of catalog) {
    if (entry.error) {
      registryLog.warn(`Skipping external plugin "${entry.plugin.id}" for CLI registration.`, {
        path: entry.path,
        error: entry.error,
      });
      continue;
    }
    loadablePlugins.push(entry.plugin);
    for (const command of entry.plugin.cliCommands ?? []) {
      registerCommand(command, entry.plugin.id, "plugin");
    }
  }

  const commands = allCommands.filter((entry) => (
    entry.source === "core" || !disabledPlugins.has(entry.ownerId)
  ));

  const lookup = new Map<string, RegisteredCliCommand>();
  for (const entry of commands) {
    lookup.set(normalizeCliCommandToken(entry.command.name), entry);
    for (const alias of entry.command.aliases ?? []) {
      lookup.set(normalizeCliCommandToken(alias), entry);
    }
  }

  return {
    commands,
    lookup,
    config,
    plugins: loadablePlugins.filter((plugin) => !disabledPlugins.has(plugin.id)),
    externalPlugins,
  };
}

export function createCliCommandContext(
  ownerId: string,
  registryOrPlugins: Pick<CliCommandRegistry, "plugins" | "externalPlugins"> | GloomPlugin[],
  cliOptions: CliGlobalOptions = DEFAULT_CLI_OPTIONS,
): CliCommandContext {
  const registry = Array.isArray(registryOrPlugins)
    ? { plugins: registryOrPlugins, externalPlugins: [] }
    : registryOrPlugins;
  return {
    initConfigData,
    initMarketData: () => initMarketData({ plugins: registry.plugins }),
    initServices: () => initCliServices({ externalPlugins: registry.externalPlugins }),
    cliOptions,
    plugins: registry.plugins,
    fail,
    closeAndFail,
    output: {
      cliStyles,
      colorBySign,
      renderSection,
      renderStat,
      renderStats,
      renderTable,
    },
    printResult: (result, options) => printCliResult(result, cliOptions, options),
    log: debugLog.createLogger(ownerId === "core" ? "cli" : ownerId),
  };
}
