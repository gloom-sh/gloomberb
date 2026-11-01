import type { AppConfig } from "../types/config";
import type {
  CliCommandContext,
  CliCommandDef,
  CliDispatchResult,
  GloomPlugin,
} from "../types/plugin";
import type { LoadedExternalPlugin } from "../plugins/loader";
import { getBuiltinCliCommands } from "../plugins/catalog-cli";
import { initCliServices, initConfigData, initMarketData } from "./context";
import { closeAndFail, fail } from "./errors";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "./options";
import { printCliResult } from "./result";
import { catalogFredSeriesIds } from "./series-search";
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
  /** Core or a built-in plugin: its declared options are the only ones it takes. External plugins are not held to theirs. */
  builtin: boolean;
}

export interface CliCommandRegistry {
  commands: RegisteredCliCommand[];
  lookup: ReadonlyMap<string, RegisteredCliCommand>;
  config: AppConfig | null;
  plugins: GloomPlugin[];
  externalPlugins: LoadedExternalPlugin[];
  /** Loads installed contributions when dispatch or application services need them. */
  ensureExternalPlugins?: () => Promise<void>;
}

interface BuildCliCommandRegistryOptions {
  coreCommands: CliCommandDef[];
  externalPlugins?: LoadedExternalPlugin[];
  loadExternalPlugins?: () => Promise<LoadedExternalPlugin[]>;
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
  loadExternalPlugins,
  config = null,
}: BuildCliCommandRegistryOptions): CliCommandRegistry {
  const allCommands: RegisteredCliCommand[] = [];
  const allTokens = new Map<string, RegisteredCliCommand>();
  const disabledPlugins = new Set(config?.disabledPlugins ?? []);

  const registerCommand = (
    command: CliCommandDef,
    ownerId: string,
    source: "core" | "plugin",
    builtin: boolean,
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

    const entry: RegisteredCliCommand = { command, ownerId, source, builtin };
    allCommands.push(entry);
    for (const token of tokens) {
      allTokens.set(token, entry);
    }
  };

  for (const command of coreCommands) {
    registerCommand(command, "core", "core", true);
  }

  for (const { pluginId, commands } of getBuiltinCliCommands()) {
    for (const command of commands) registerCommand(command, pluginId, "plugin", true);
  }
  for (const entry of externalPlugins) {
    if (entry.error) {
      registryLog.warn(`Skipping external plugin "${entry.plugin.id}" for CLI registration.`, {
        path: entry.path,
        error: entry.error,
      });
      continue;
    }
    for (const command of entry.plugin.cliCommands ?? []) {
      registerCommand(command, entry.plugin.id, "plugin", false);
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

  let plugins: GloomPlugin[] | undefined;
  let loading: Promise<void> | undefined;
  const registry: CliCommandRegistry = {
    commands,
    lookup,
    config,
    get plugins() {
      const { getPluginCatalog } = require("../plugins/catalog") as typeof import("../plugins/catalog");
      return plugins ??= getPluginCatalog(registry.externalPlugins)
        .filter((entry) => !entry.error && !disabledPlugins.has(entry.plugin.id))
        .map((entry) => entry.plugin);
    },
    externalPlugins,
    ...(loadExternalPlugins ? { ensureExternalPlugins: () => loading ??= (async () => {
      const loaded = await loadExternalPlugins();
      const expanded = buildCliCommandRegistry({ coreCommands, externalPlugins: loaded, config });
      registry.commands = expanded.commands;
      registry.lookup = expanded.lookup;
      registry.externalPlugins = loaded;
      // A command can retain ctx.plugins before opening market data (search does).
      // Keep that reference current without materializing panes for command-only work.
      if (plugins) plugins.splice(0, plugins.length, ...expanded.plugins);
    })() } : {}),
  };
  return registry;
}

export function createCliCommandContext(
  ownerId: string,
  registryOrPlugins: Pick<CliCommandRegistry, "plugins" | "externalPlugins" | "ensureExternalPlugins"> | GloomPlugin[],
  cliOptions: CliGlobalOptions = DEFAULT_CLI_OPTIONS,
  args: readonly string[] = [],
): CliCommandContext {
  const registry: Pick<CliCommandRegistry, "plugins" | "externalPlugins" | "ensureExternalPlugins"> = Array.isArray(registryOrPlugins)
    ? { plugins: registryOrPlugins, externalPlugins: [] }
    : registryOrPlugins;
  return {
    initConfigData,
    initMarketData: async () => {
      await registry.ensureExternalPlugins?.();
      return initMarketData({ plugins: registry.plugins });
    },
    initServices: async () => {
      await registry.ensureExternalPlugins?.();
      return initCliServices({ externalPlugins: registry.externalPlugins });
    },
    cliOptions,
    get plugins() { return registry.plugins; },
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
    printResult: (result, options) => printCliResult(result, cliOptions, options, args,
      (id) => catalogFredSeriesIds(registry.plugins).has(id)),
    log: debugLog.createLogger(ownerId === "core" ? "cli" : ownerId),
  };
}
