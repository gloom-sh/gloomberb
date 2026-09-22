import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VERSION } from "../../version";
import { saveConfig } from "../../data/config/store";
import { apiClient } from "../../api-client";
import { readChatSessionState } from "../../plugins/builtin/chat/controller/persistence";
import { exportNotesToDirectory, type NotesExportSource } from "../../plugins/builtin/notes/export";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { CloudNotesStore } from "../../plugins/builtin/notes/store";
import { createPluginPersistence } from "../../plugins/plugin-persistence";
import { createAlert, deserializeAlerts, serializeAlerts } from "../../plugins/builtin/alerts/alert-engine";
import type { AlertCondition } from "../../plugins/builtin/alerts/types";
import type { CliCommandDef } from "../../types/plugin";
import { debugLog, type LogLevel } from "../../utils/debug-log";
import { withCliServices, withConfigData } from "../context";
import { CLI_COMMAND_GROUPS } from "../help";
import { formatBytes, formatStatusCell } from "../helpers";
import { cliStyles, cliTerminalWidth, renderSection, renderTable, wrapText } from "../../utils/cli-output";
import { parsePositiveInt, requireArg, takeOption } from "./command-utils";
import {
  applyKeybindingCliSet,
  describeKeybindingsForCli,
  KEYBINDINGS_CONFIG_KEY,
} from "./keybindings";

const ALERTS_PLUGIN_ID = "alerts";
const ALERTS_KEY = "alerts";
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

const DOCTOR_COUNT_UNITS: Record<string, string> = { plugins: "loaded", capabilities: "registered" };
const EDITABLE_CONFIG_KEYS = ["baseCurrency", "refreshIntervalMinutes", "theme", "valueFlashingEnabled"];
const LOG_LEVEL_STYLES: Partial<Record<LogLevel, (text: string) => string>> = {
  debug: cliStyles.muted,
  warn: cliStyles.warning,
  error: cliStyles.danger,
};

function commandRows(commands: CliCommandDef[]) {
  return commands.map((command) => ({
    name: command.name,
    aliases: command.aliases?.join(",") ?? "",
    description: command.description,
    group: command.help?.group ?? "",
  }));
}

function dryRunNote(dryRun: boolean): string {
  return dryRun ? cliStyles.muted(" (dry run, nothing saved)") : "";
}

function describeConfigValue(value: unknown): string {
  if (value == null) return "nothing";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "nothing";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function summarizeKeybindings(value: unknown): string {
  const described = value as { actions?: Record<string, unknown>; commands?: Record<string, unknown>; issues?: unknown[] };
  const parts = [
    `${Object.keys(described.actions ?? {}).length} actions`,
    `${Object.keys(described.commands ?? {}).length} command bindings`,
    ...(described.issues?.length ? [cliStyles.warning(`${described.issues.length} issues`)] : []),
  ];
  return `${parts.join(", ")} ${cliStyles.muted("(gloomberb config get keybindings)")}`;
}

function renderKeybindings(value: unknown): string {
  const described = value as {
    actions: Record<string, { keys: string[]; custom?: boolean; defaults?: string[] }>;
    commands: Record<string, string>;
    issues: string[];
  };
  const lines = [
    renderSection("Actions"),
    renderTable(
      [{ header: "Action" }, { header: "Keys" }, { header: "Default" }],
      Object.entries(described.actions).map(([id, action]) => [
        id,
        action.keys.length > 0 ? action.keys.join(", ") : cliStyles.muted("unbound"),
        action.custom ? cliStyles.muted(action.defaults?.join(", ") || "unbound") : "",
      ]),
    ),
    "",
    renderSection("Command bindings"),
    Object.keys(described.commands).length > 0
      ? renderTable(
        [{ header: "Keys" }, { header: "Runs" }],
        Object.entries(described.commands).map(([chord, query]) => [chord, query]),
      )
      : wrapText("None. Bind one with gloomberb config set keybindings.commands.<keys> <command>.", cliTerminalWidth() ?? 80)
        .map((line) => cliStyles.muted(line)).join("\n"),
  ];
  if (described.issues.length > 0) {
    lines.push("", renderSection("Issues"), ...described.issues.map((issue) => cliStyles.warning(issue)));
  }
  return lines.join("\n");
}

function formatLogTime(value: unknown): string {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number, size = 2) => String(part).padStart(size, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  return value && LOG_LEVELS.has(value as LogLevel) ? value as LogLevel : undefined;
}

function resourceCacheStats(
  services: Awaited<ReturnType<Parameters<CliCommandDef["execute"]>[1]["initServices"]>>,
  namespace?: string,
) {
  const where = namespace ? "WHERE namespace = ?1" : "";
  const row = services.persistence.database.connection
    .query<{ count: number; size: number; expired: number; stale: number }, string[]>(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(size_bytes), 0) as size,
              SUM(CASE WHEN expires_at < strftime('%s','now') * 1000 THEN 1 ELSE 0 END) as expired,
              SUM(CASE WHEN stale_at < strftime('%s','now') * 1000 THEN 1 ELSE 0 END) as stale
       FROM resource_cache ${where}`,
    )
    .get(...(namespace ? [namespace] : []));
  return {
    entries: row?.count ?? 0,
    sizeBytes: row?.size ?? 0,
    staleEntries: row?.stale ?? 0,
    expiredEntries: row?.expired ?? 0,
  };
}

export function createSystemCliCommands(allCommands: () => CliCommandDef[]): CliCommandDef[] {
  const versionCommand: CliCommandDef = {
    name: "version",
    aliases: ["--version", "-v"],
    description: "Print the version, runtime, and data folder",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["version"] },
    execute: async (_args, ctx) => {
      let dataDir: string | null = null;
      try {
        dataDir = await withConfigData(ctx, ({ dataDir: configuredDataDir }) => configuredDataDir);
      } catch {
        dataDir = null;
      }
      ctx.printResult({
        data: [{
          version: VERSION,
          bun: typeof Bun === "undefined" ? null : Bun.version,
          platform: process.platform,
          arch: process.arch,
          dataDir,
        }],
      }, { layout: "record" });
    },
  };

  const doctorCommand: CliCommandDef = {
    name: "doctor",
    description: "Check that config, cache, plugins, and capabilities load",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["doctor"] },
    execute: async (_args, ctx) => {
      const checks: Array<{ check: string; status: string; detail: string }> = [];
      try {
        await withCliServices(ctx, async (services) => {
          checks.push({ check: "config", status: "ok", detail: services.dataDir });
          checks.push({ check: "database", status: "ok", detail: join(services.dataDir, ".gloomberb-cache.db") });
          checks.push({ check: "plugins", status: "ok", detail: String(services.services.pluginRegistry.allPlugins.size) });
          checks.push({ check: "capabilities", status: "ok", detail: String(services.services.pluginRegistry.capabilities.manifests().length) });
        });
      } catch (error) {
        checks.push({ check: "runtime", status: "error", detail: error instanceof Error ? error.message : String(error) });
      }
      ctx.printResult({ data: checks }, {
        columns: [
          { key: "check", header: "Check" },
          { key: "status", header: "Status", format: formatStatusCell },
          { key: "detail", header: "Detail", format: (value, row) => DOCTOR_COUNT_UNITS[String(row.check)] ? `${value} ${DOCTOR_COUNT_UNITS[String(row.check)]}` : String(value) },
        ],
      });
      if (checks.some((check) => check.status === "error")) process.exitCode = 1;
    },
  };

  const configCommand: CliCommandDef = {
    name: "config",
    description: "Show or change settings and keybindings",
    help: {
      group: CLI_COMMAND_GROUPS.app,
      usage: [
        "config list",
        "config get <key>",
        "config set <key> <value>",
        "config get keybindings",
        "config set keybindings.actions.<action> <keys>|null|default",
        "config set keybindings.commands.<keys> <command>|null",
      ],
      sections: [{
        title: "Editable keys",
        lines: [`${EDITABLE_CONFIG_KEYS.join(", ")}, and keybindings.*`],
      }],
      examples: [
        "config",
        "config set baseCurrency EUR",
        "config get keybindings",
        "config set keybindings.actions.ticker-search \"Ctrl+T\"",
        "config set keybindings.commands.Alt+1 \"DES AAPL\"",
      ],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "list";
      await withConfigData(ctx, async (context) => {
        const safeConfig: Record<string, unknown> = {
          dataDir: context.config.dataDir,
          baseCurrency: context.config.baseCurrency,
          refreshIntervalMinutes: context.config.refreshIntervalMinutes,
          theme: context.config.theme,
          disabledPlugins: context.config.disabledPlugins,
          disabledSources: context.config.disabledSources,
          portfolios: context.config.portfolios.length,
          watchlists: context.config.watchlists.length,
          brokerInstances: context.config.brokerInstances.length,
          [KEYBINDINGS_CONFIG_KEY]: describeKeybindingsForCli(context.config),
          // Last, so CSV readers that go by position keep their columns.
          valueFlashingEnabled: context.config.valueFlashingEnabled,
        };

        if (action === "list") {
          ctx.printResult({ data: safeConfig }, {
            textColumns: Object.keys(safeConfig).map((key) => ({
              key,
              header: key,
              ...(key === KEYBINDINGS_CONFIG_KEY ? { format: summarizeKeybindings } : {}),
            })),
          });
          return;
        }
        if (action === "get") {
          const key = requireArg(args[1], "Usage: gloomberb config get <key>", ctx);
          if (!Object.prototype.hasOwnProperty.call(safeConfig, key)) {
            ctx.fail(`Unknown config key "${key}".`, `Keys: ${Object.keys(safeConfig).join(", ")}`);
          }
          ctx.printResult({ data: { key, value: safeConfig[key] } }, {
            text: (data) => key === KEYBINDINGS_CONFIG_KEY ? renderKeybindings(data.value) : describeConfigValue(data.value),
          });
          return;
        }
        if (action === "set") {
          const key = requireArg(args[1], "Usage: gloomberb config set <key> <value>", ctx);
          const value = requireArg(args[2], "Usage: gloomberb config set <key> <value>", ctx);
          if (key.startsWith(`${KEYBINDINGS_CONFIG_KEY}.`)) {
            // The value may carry several chords or a multi-word command, so
            // everything after the key is the value.
            const result = applyKeybindingCliSet(context.config, key, args.slice(2).join(" "));
            if (!result.ok) return ctx.fail(result.message);
            if (!ctx.cliOptions.dryRun) await saveConfig(result.config);
            ctx.printResult({
              data: {
                changed: !ctx.cliOptions.dryRun,
                dryRun: ctx.cliOptions.dryRun,
                key,
                value: result.value,
                [KEYBINDINGS_CONFIG_KEY]: describeKeybindingsForCli(result.config),
              },
            }, {
              text: (data) => `Set ${key} to ${describeConfigValue(data.value)}.${dryRunNote(data.dryRun)}`,
            });
            return;
          }
          if (!EDITABLE_CONFIG_KEYS.includes(key)) {
            ctx.fail(`Config key "${key}" is not editable from the CLI.`, `Editable keys: ${EDITABLE_CONFIG_KEYS.join(", ")}, keybindings.*`);
          }
          const parsedValue = key === "refreshIntervalMinutes"
            ? Number(value)
            : key === "valueFlashingEnabled"
              ? value === "true"
              : value;
          const nextConfig = { ...context.config, [key]: parsedValue };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, key, value: parsedValue } }, {
            text: (data) => `Set ${key} to ${describeConfigValue(data.value)}.${dryRunNote(data.dryRun)}`,
          });
          return;
        }
        ctx.fail("Usage: gloomberb config list|get|set");
      });
    },
  };

  const cacheCommand: CliCommandDef = {
    name: "cache",
    description: "Show the size of cached market data, or clear it",
    help: {
      group: CLI_COMMAND_GROUPS.app,
      usage: ["cache status", "cache clear [namespace]"],
      examples: ["cache", "cache clear --dry-run", "cache clear"],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "status";
      await withCliServices(ctx, async (services) => {
        if (action === "status") {
          ctx.printResult({ data: [resourceCacheStats(services)] }, {
            layout: "record",
            textColumns: [
              { key: "entries", header: "Entries" },
              { key: "sizeBytes", header: "Size", format: (value) => formatBytes(Number(value)) },
              { key: "staleEntries", header: "Stale" },
              { key: "expiredEntries", header: "Expired" },
            ],
          });
          return;
        }
        if (action === "clear") {
          const namespace = args[1];
          const before = resourceCacheStats(services, namespace);
          if (!ctx.cliOptions.dryRun) services.persistence.resources.clear(namespace);
          const after = ctx.cliOptions.dryRun ? before : resourceCacheStats(services, namespace);
          ctx.printResult({ data: [{ changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, namespace: namespace ?? "all", before: before.entries, after: after.entries }] }, {
            text: ([data]) => {
              const scope = namespace ? ` from ${namespace}` : "";
              return data!.dryRun
                ? `Would clear ${data!.before} cached entries${scope}.${dryRunNote(true)}`
                : `Cleared ${data!.before - data!.after} cached entries${scope}.`;
            },
          });
          return;
        }
        ctx.fail("Usage: gloomberb cache status|clear");
      });
    },
  };

  const providerCommand: CliCommandDef = {
    name: "provider",
    aliases: ["providers"],
    description: "List data sources and the operations each one serves",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["provider status"] },
    execute: async (_args, ctx) => {
      await withCliServices(ctx, async (services) => {
        const disabledSources = new Set(services.config.disabledSources ?? []);
        const rows = services.services.pluginRegistry.capabilities.manifests().map((manifest) => ({
          id: manifest.sourceId ?? manifest.id,
          capability: manifest.id,
          kind: manifest.kind,
          enabled: !disabledSources.has(manifest.sourceId ?? manifest.id),
          operations: manifest.operations.map((operation) => operation.id).join(","),
        }));
        ctx.printResult({ data: rows }, {
          columns: [
            { key: "id", header: "Source" },
            { key: "kind", header: "Kind" },
            { key: "enabled", header: "Enabled" },
            { key: "operations", header: "Operations" },
          ],
          textColumns: [
            { key: "capability", header: "Capability", shrink: false },
            { key: "id", header: "Source", maxWidth: 20 },
            { key: "kind", header: "Kind", shrink: false },
            { key: "enabled", header: "Enabled" },
            { key: "operations", header: "Operations", format: (value) => String(value).split(",").join(", ") },
          ],
        });
      });
    },
  };

  const pluginCommand: CliCommandDef = {
    name: "plugin",
    description: "Inspect, turn on or off, link, or check any plugin",
    help: {
      group: CLI_COMMAND_GROUPS.plugins,
      usage: [
        "plugin list",
        "plugin info <id>",
        "plugin enable <id>",
        "plugin disable <id>",
        "plugin doctor [name-or-path]",
        "plugin link <path>",
      ],
      sections: [{
        title: "Developing a plugin",
        lines: [
          "link puts a symlink to a local checkout in the plugins folder, so edits are live on the next start.",
          "doctor checks an installed or linked plugin the way the app and the desktop build will: entry, export, id, targets, declared hosts, and the browser bundle. Run it before publishing.",
        ],
      }],
      examples: ["plugin list", "plugin info news", "plugin disable hackernews", "plugin link ../my-plugin", "plugin doctor ../my-plugin"],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "list";
      // These work on the folder, not the running registry, so a plugin that
      // fails to load can still be inspected and repaired.
      if (action === "doctor") {
        const { doctorPlugins } = await import("./plugins");
        const reports = await doctorPlugins(args[1]);
        ctx.printResult({ data: reports }, {
          rows: (data) => data.flatMap((report) => report.checks.map((check) => ({
            plugin: report.name ?? report.directory,
            check: check.id,
            status: check.status,
            detail: check.message,
          }))),
          columns: [
            { key: "plugin", header: "Plugin", shrink: false },
            { key: "check", header: "Check" },
            { key: "status", header: "Status", format: formatStatusCell },
            { key: "detail", header: "Detail" },
          ],
        });
        if (reports.some((report) => report.status === "fail")) process.exitCode = 1;
        return;
      }
      if (action === "link") {
        const path = requireArg(args[1], "Usage: gloomberb plugin link <path>", ctx);
        const { linkPlugin } = await import("./plugins");
        const info = await linkPlugin(path, { quiet: ctx.cliOptions.format !== "text" });
        if (ctx.cliOptions.format !== "text") ctx.printResult({ data: info });
        return;
      }
      await withCliServices(ctx, async (services) => {
        const pluginRows = () => [...services.services.pluginRegistry.allPlugins.values()].map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          enabled: !services.config.disabledPlugins.includes(plugin.id),
          panes: services.services.pluginRegistry.getPluginPaneIds(plugin.id).length,
          templates: services.services.pluginRegistry.getPluginPaneTemplateIds(plugin.id).length,
          capabilities: services.services.pluginRegistry.capabilities.manifests().filter((manifest) => (
            services.services.pluginRegistry.getCapabilityPluginId(manifest.id) === plugin.id
          )).length,
        }));

        if (action === "list") {
          ctx.printResult({ data: pluginRows() });
          return;
        }
        if (action === "info") {
          const id = requireArg(args[1], "Usage: gloomberb plugin info <id>", ctx);
          const row = pluginRows().find((plugin) => plugin.id === id);
          if (!row) ctx.fail(`Plugin "${id}" is not available.`);
          ctx.printResult({ data: row });
          return;
        }
        if (action === "enable" || action === "disable") {
          const id = requireArg(args[1], `Usage: gloomberb plugin ${action} <id>`, ctx);
          const plugin = services.services.pluginRegistry.allPlugins.get(id);
          if (!plugin) ctx.fail(`Plugin "${id}" is not available.`);
          if (plugin?.toggleable !== true) ctx.fail(`Plugin "${id}" is part of the application and cannot be disabled.`);
          const disabled = new Set(services.config.disabledPlugins ?? []);
          const before = disabled.has(id);
          if (action === "enable") disabled.delete(id);
          else disabled.add(id);
          const nextConfig = { ...services.config, disabledPlugins: [...disabled] };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
          ctx.printResult({ data: { changed: before !== disabled.has(id) && !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, id, enabled: !disabled.has(id) } }, {
            text: (data) => {
              const state = data.enabled ? "on" : "off";
              if (before === disabled.has(id)) return `${id} is already ${state}.`;
              return `Turned ${id} ${state}.${dryRunNote(data.dryRun)}`;
            },
          });
          return;
        }
        ctx.fail("Usage: gloomberb plugin list|info|enable|disable|doctor|link");
      });
    },
  };

  const layoutCommand: CliCommandDef = {
    name: "layout",
    description: "List saved layouts",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["layout"] },
    execute: async (_args, ctx) => {
      await withConfigData(ctx, async (config) => {
        const rows = config.config.layouts.map((layout, index) => ({
          index,
          active: index === config.config.activeLayoutIndex,
          name: layout.name,
          panes: layout.layout.instances.length,
          floating: layout.layout.floating.length,
          detached: layout.layout.detached.length,
        }));
        ctx.printResult({ data: rows });
      });
    },
  };

  const paneCommand: CliCommandDef = {
    name: "pane",
    description: "List panes and templates with the plugin that owns each",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["pane list"] },
    execute: async (_args, ctx) => {
      await withCliServices(ctx, async (services) => {
        const rows = [
          ...[...services.services.pluginRegistry.panes.entries()].map(([id, pane]) => ({
            kind: "pane",
            id,
            name: pane.name,
            owner: services.services.pluginRegistry.getPanePluginId(id) ?? "",
          })),
          ...[...services.services.pluginRegistry.paneTemplates.entries()].map(([id, template]) => ({
            kind: "template",
            id,
            name: template.label,
            owner: services.services.pluginRegistry.getPaneTemplatePluginId(id) ?? "",
          })),
        ];
        ctx.printResult({ data: rows }, {
          columns: [
            { key: "kind", header: "Kind" },
            { key: "id", header: "ID", shrink: false },
            { key: "name", header: "Name" },
            { key: "owner", header: "Owner" },
          ],
        });
      });
    },
  };

  const notesCommand: CliCommandDef = {
    name: "notes",
    description: "Read, write, or export ticker notes",
    help: {
      group: CLI_COMMAND_GROUPS.portfolios,
      usage: ["notes show <symbol>", "notes set <symbol> <text...>", "notes delete <symbol>", "notes quick list", "notes export [dir]"],
      examples: ["notes show AAPL", "notes set AAPL \"Services margin above 70%\"", "notes export ~/notes"],
    },
    execute: async (args, ctx) => {
      await withConfigData(ctx, async (config) => {
        const notes = new NotesFiles(config.dataDir);
        const action = args[0] ?? "list";
        if (action === "export") {
          // Local files plus, when a saved session exists, the cloud copies
          // (personal and every team), one folder each.
          const dir = args[1] ?? join(config.dataDir, `notes-export-${new Date().toISOString().slice(0, 10)}`);
          const sources: NotesExportSource[] = [{ label: "local", store: notes }];
          await withCliServices(ctx, async (services) => {
            const cloudPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:gloomberb-cloud", "gloomberb-cloud");
            const session = readChatSessionState(cloudPersistence, null);
            if (!session?.sessionToken) return;
            apiClient.setSessionToken(session.sessionToken);
            const user = await apiClient.ensureVerifiedSession().catch(() => null);
            if (!user) return;
            const notesPersistence = createPluginPersistence(services.persistence.pluginState, services.persistence.resources, "plugin:notes", "notes");
            sources.push({ label: "mine", store: new CloudNotesStore({ kind: "user" }, notesPersistence) });
            const teams = await apiClient.listTeams().catch(() => []);
            for (const team of teams) {
              sources.push({ label: team.name, store: new CloudNotesStore({ kind: "team", teamId: team.id }, notesPersistence) });
            }
          });
          if (ctx.cliOptions.dryRun) {
            ctx.printResult({ data: { dryRun: true, dir, sources: sources.map((source) => source.label) } }, {
              text: (data) => `Would export ${data.sources.join(", ")} notes to ${data.dir}.${dryRunNote(true)}`,
            });
            return;
          }
          const result = await exportNotesToDirectory(dir, sources);
          ctx.printResult({ data: { dir: result.dir, files: result.files, sources: sources.map((source) => source.label) } }, {
            text: (data) => `Exported ${data.files} notes from ${data.sources.join(", ")} to ${data.dir}.`,
          });
          return;
        }
        if (action === "quick") {
          const subaction = args[1] ?? "list";
          if (subaction !== "list") ctx.fail("Usage: gloomberb notes quick list");
          const entries = await notes.loadQuickNotesIndex();
          ctx.printResult({ data: entries }, { empty: "No quick notes." });
          return;
        }
        if (action === "show") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes show <symbol>", ctx);
          ctx.printResult({ data: { symbol, text: await notes.load(symbol) } }, {
            text: (data) => data.text?.trim() ? data.text.trimEnd() : cliStyles.muted(`No note for ${symbol}.`),
          });
          return;
        }
        if (action === "set") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes set <symbol> <text...>", ctx);
          const text = args.slice(2).join(" ");
          if (!ctx.cliOptions.dryRun) await notes.save(symbol, text);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol, bytes: text.length } }, {
            text: (data) => `Saved the note for ${symbol}.${dryRunNote(data.dryRun)}`,
          });
          return;
        }
        if (action === "delete" || action === "rm") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes delete <symbol>", ctx);
          // Only picks the message; an unreadable note is still deleted.
          const existed = await notes.load(symbol).then((text) => !!text?.trim(), () => true);
          if (!ctx.cliOptions.dryRun) await notes.delete(symbol);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol } }, {
            text: (data) => existed
              ? `Deleted the note for ${symbol}.${dryRunNote(data.dryRun)}`
              : cliStyles.muted(`No note for ${symbol}.`),
          });
          return;
        }
        ctx.fail("Usage: gloomberb notes show|set|delete|quick|export");
      });
    },
  };

  const alertsCommand: CliCommandDef = {
    name: "alerts",
    aliases: ["alert"],
    description: "List, add, and remove price alerts",
    help: {
      group: CLI_COMMAND_GROUPS.portfolios,
      usage: ["alerts list", "alerts add <symbol> <above|below|crosses> <price>", "alerts delete <id>", "alerts rearm <id>"],
      examples: ["alerts", "alerts add AAPL above 250", "alerts add BTC-USD below 60000"],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "list";
      await withConfigData(ctx, async (config) => {
        const raw = config.config.pluginConfig[ALERTS_PLUGIN_ID]?.[ALERTS_KEY];
        const alerts = deserializeAlerts(typeof raw === "string" ? raw : "[]");
        const saveAlerts = async (nextAlerts: typeof alerts) => {
          const nextConfig = {
            ...config.config,
            pluginConfig: {
              ...config.config.pluginConfig,
              [ALERTS_PLUGIN_ID]: {
                ...(config.config.pluginConfig[ALERTS_PLUGIN_ID] ?? {}),
                [ALERTS_KEY]: serializeAlerts(nextAlerts),
              },
            },
          };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
        };

        if (action === "list") {
          ctx.printResult({ data: alerts }, {
            textColumns: [
              { key: "id", header: "ID", shrink: false },
              { key: "symbol", header: "Symbol" },
              { key: "condition", header: "Condition" },
              { key: "targetPrice", header: "Target", align: "right" },
              { key: "status", header: "Status" },
              { key: "lastCheckedPrice", header: "Last Price", align: "right", optional: true },
              { key: "createdAt", header: "Created", optional: true },
              { key: "triggeredAt", header: "Triggered" },
            ],
            empty: "No alerts. Add one with gloomberb alerts add <symbol> <above|below|crosses> <price>.",
          });
          return;
        }
        if (action === "add") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx);
          const condition = requireArg(args[2], "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx) as AlertCondition;
          if (!["above", "below", "crosses"].includes(condition)) ctx.fail("Condition must be above, below, or crosses.");
          const price = Number(requireArg(args[3], "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx));
          if (!Number.isFinite(price)) ctx.fail("Alert price must be a finite number.");
          const alert = createAlert(symbol, condition, price);
          await saveAlerts([...alerts, alert]);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert } }, {
            text: (data) => `Added alert ${data.alert.id}: ${symbol} ${condition} ${price}.${dryRunNote(data.dryRun)}`,
          });
          return;
        }
        if (action === "delete" || action === "rm") {
          const id = requireArg(args[1], "Usage: gloomberb alerts delete <id>", ctx);
          const next = alerts.filter((alert) => alert.id !== id);
          await saveAlerts(next);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && next.length !== alerts.length, dryRun: ctx.cliOptions.dryRun, id } }, {
            text: (data) => next.length === alerts.length
              ? cliStyles.muted(`No alert with ID ${id}.`)
              : `Deleted alert ${id}.${dryRunNote(data.dryRun)}`,
          });
          return;
        }
        if (action === "rearm") {
          const id = requireArg(args[1], "Usage: gloomberb alerts rearm <id>", ctx);
          const next = alerts.map((alert) => alert.id === id ? { ...alert, status: "active" as const, triggeredAt: undefined } : alert);
          await saveAlerts(next);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, id } }, {
            text: (data) => alerts.some((alert) => alert.id === id)
              ? `Re-armed alert ${id}.${dryRunNote(data.dryRun)}`
              : cliStyles.muted(`No alert with ID ${id}.`),
          });
          return;
        }
        ctx.fail("Usage: gloomberb alerts list|add|delete|rearm");
      });
    },
  };

  const debugCommand: CliCommandDef = {
    name: "debug",
    description: "Show, export, or clear the debug log of this command run",
    help: {
      group: CLI_COMMAND_GROUPS.app,
      usage: ["debug logs [--source <name>] [--level <level>]", "debug export [--output <path>]", "debug clear"],
      options: [
        { flags: "--source <name>", description: "Only entries from one logger" },
        { flags: "--level <level>", description: "debug, info, warn, or error" },
        { flags: "--output <path>", description: "With export, write to a file instead of printing" },
      ],
    },
    execute: async (rawArgs, ctx) => {
      const args = [...rawArgs];
      const action = args[0] ?? "logs";
      const source = takeOption(args, "--source");
      const level = parseLogLevel(takeOption(args, "--level"));
      if (action === "clear") {
        debugLog.clear();
        ctx.printResult({ data: { changed: true } }, { text: () => "Cleared the debug log." });
        return;
      }
      if (action === "export") {
        const output = takeOption(args, "--output");
        const text = debugLog.exportAsText({ source, level });
        if (output) writeFileSync(output, text);
        ctx.printResult({ data: { output: output ?? null, bytes: text.length, text: output ? undefined : text } }, {
          text: (data) => data.output ? `Wrote ${formatBytes(data.bytes)} to ${data.output}.` : text.trimEnd(),
        });
        return;
      }
      const entries = debugLog.getEntries({ source, level }).slice(-(ctx.cliOptions.limit ?? 50));
      ctx.printResult({ data: entries }, {
        columns: [
          { key: "id", header: "ID", align: "right" },
          { key: "timestamp", header: "Time", value: (row) => new Date(Number(row.timestamp)).toISOString(), format: (_value, row) => formatLogTime(row.timestamp) },
          { key: "level", header: "Level", format: (value) => (LOG_LEVEL_STYLES[value as LogLevel] ?? String)(String(value)) },
          { key: "source", header: "Source" },
          { key: "message", header: "Message" },
        ],
        empty: "The debug log is empty.",
      });
    },
  };

  const changelogCommand: CliCommandDef = {
    name: "changelog",
    description: "Print the changelog or release notes in this folder",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["changelog [lines]"] },
    execute: async (args, ctx) => {
      const limit = parsePositiveInt(args[0], ctx.cliOptions.limit ?? 80, "Line count", ctx);
      const candidates = ["CHANGELOG.md", "CHANGELOG", "RELEASE_NOTES.md", "README.md"];
      const found = candidates.find((candidate) => existsSync(candidate));
      const text = found ? readFileSync(found, "utf8").split("\n").slice(0, limit).join("\n") : "";
      ctx.printResult({ data: { path: found ?? null, text, version: VERSION } }, {
        text: (data) => data.path ? data.text.trimEnd() : cliStyles.muted("No changelog or release notes in this folder."),
      });
    },
  };

  const commandCatalogCommand: CliCommandDef = {
    name: "command",
    aliases: ["commands"],
    description: "List every command with its group and aliases",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["command"] },
    execute: (_args, ctx) => {
      ctx.printResult({ data: commandRows(allCommands()) }, {
        columns: [
          { key: "name", header: "Command", shrink: false },
          { key: "aliases", header: "Aliases", format: (value) => String(value).split(",").join(", ") },
          { key: "description", header: "Description" },
          { key: "group", header: "Group" },
        ],
      });
    },
  };

  const coverageCommand: CliCommandDef = {
    name: "coverage",
    description: "Show which panes and capabilities the CLI reaches",
    help: { group: CLI_COMMAND_GROUPS.app, usage: ["coverage"] },
    execute: async (_args, ctx) => {
      const commandNames = new Set(allCommands().map((command) => command.name));
      await withCliServices(ctx, async (services) => {
        const rows = [
          ...[...services.services.pluginRegistry.panes.entries()].map(([id, pane]) => ({
            surface: "pane",
            id,
            label: pane.name,
            coverage: commandNames.has(id) ? "first-class" : "visual-only",
            command: commandNames.has(id) ? id : "fn/shot",
          })),
          ...[...services.services.pluginRegistry.paneTemplates.entries()].map(([id, template]) => {
            const direct = [id, template.paneId, template.shortcut?.prefix?.toLowerCase()]
              .filter((value): value is string => !!value)
              .find((value) => commandNames.has(value));
            return {
              surface: "template",
              id,
              label: template.label,
              coverage: direct ? "first-class" : "visual-only",
              command: direct ?? "fn/shot",
            };
          }),
          ...services.services.pluginRegistry.capabilities.manifests().map((manifest) => ({
            surface: "capability",
            id: manifest.id,
            label: manifest.name,
            coverage: "api",
            command: "api list|get|invoke|subscribe",
          })),
          ...["auth", "account-management", "chat"].map((id) => ({
            surface: "deferred",
            id,
            label: id,
            coverage: "deferred",
            command: "",
          })),
        ];
        ctx.printResult({ data: rows }, {
          columns: [
            { key: "surface", header: "Surface" },
            { key: "id", header: "ID", shrink: false },
            { key: "coverage", header: "Coverage" },
            { key: "command", header: "Command" },
            { key: "label", header: "Label" },
          ],
        });
      });
    },
  };

  return [
    versionCommand,
    doctorCommand,
    configCommand,
    cacheCommand,
    providerCommand,
    pluginCommand,
    layoutCommand,
    paneCommand,
    notesCommand,
    alertsCommand,
    debugCommand,
    changelogCommand,
    commandCatalogCommand,
    coverageCommand,
  ];
}
