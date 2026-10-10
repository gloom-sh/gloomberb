import { join } from "path";
import { VERSION } from "../../version";
import { saveConfig } from "../../data/config/store";
import { builtinPluginGroupMembers } from "../../plugins/ownership";
import type { TelemetryConfig } from "../../types/config";
import type { CliCommandDef } from "../../types/plugin";
import { withCliServices, withConfigData } from "../context";
import { CLI_COMMAND_GROUPS } from "../help";
import { dryRunNote, formatBytes, formatStatusCell } from "../helpers";
import { cliStyles, cliTerminalWidth, renderSection, renderTable, wrapText } from "../../utils/cli-output";
import { getThemeIds } from "../../theme/themes";
import { requireArg } from "./command-utils";
import { describeThemeId, requireThemeId, themeListNote, themeListRows, themeName } from "./themes";
import {
  applyKeybindingCliSet,
  describeKeybindingsForCli,
  KEYBINDINGS_CONFIG_KEY,
} from "./keybindings";

const DOCTOR_COUNT_UNITS: Record<string, string> = { plugins: "loaded", capabilities: "registered" };
/** Automatic crash reports and anonymous usage counts, keyed by their field in `telemetry`. */
const TELEMETRY_CONFIG_KEYS = {
  "telemetry.crashReports": "crashReports",
  "telemetry.usage": "usage",
  "telemetry.attention": "attention",
} as const satisfies Record<string, keyof TelemetryConfig>;
type TelemetryConfigKey = keyof typeof TELEMETRY_CONFIG_KEYS;
/** The one-time GitHub star line in the terminal's status bar. */
const STAR_PROMPT_CONFIG_KEY = "starPrompt.enabled";
const EDITABLE_CONFIG_KEYS = [
  "baseCurrency",
  "refreshIntervalMinutes",
  "theme",
  "valueFlashingEnabled",
  ...Object.keys(TELEMETRY_CONFIG_KEYS),
  STAR_PROMPT_CONFIG_KEY,
];

function isTelemetryConfigKey(key: string): key is TelemetryConfigKey {
  return Object.prototype.hasOwnProperty.call(TELEMETRY_CONFIG_KEYS, key);
}

function isBooleanConfigKey(key: string): boolean {
  return key === "valueFlashingEnabled" || key === STAR_PROMPT_CONFIG_KEY || isTelemetryConfigKey(key);
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

export function createSystemCliCommands(): CliCommandDef[] {
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
          const theme = services.config.theme;
          checks.push({
            check: "theme",
            status: themeName(theme) ? "ok" : "warn",
            detail: themeName(theme) ? describeThemeId(theme) : `${describeThemeId(theme)}. Pick one with gloomberb config set theme <id>.`,
          });
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
        "config themes",
        "config set theme <id>",
        "config set telemetry.crashReports false",
        "config set telemetry.usage false",
        "config set starPrompt.enabled false",
        "config get keybindings",
        "config set keybindings.actions.<action> <keys>|null|default",
        "config set keybindings.commands.<keys> <command>|null",
      ],
      sections: [{
        title: "Editable keys",
        lines: [`${EDITABLE_CONFIG_KEYS.join(", ")}, and keybindings.*`],
      }, {
        title: "Themes",
        lines: [
          `theme takes one of these ids, or its name as config themes lists it: ${getThemeIds().join(", ")}.`,
        ],
      }],
      examples: [
        "config",
        "config themes",
        "config set theme colorblind",
        "config set baseCurrency EUR",
        "config get keybindings",
        "config set keybindings.actions.ticker-search \"Ctrl+T\"",
        "config set keybindings.commands.Alt+1 \"DES AAPL\"",
      ],
    },
    execute: async (args, ctx) => {
      const action = args[0] ?? "list";
      // Listing the themes needs no data folder, so it works before the first run.
      if (action === "themes") {
        let current: string | null = null;
        try {
          current = await withConfigData(ctx, ({ config }) => config.theme);
        } catch {
          current = null;
        }
        ctx.printResult({ data: themeListRows(current) }, {
          textColumns: [
            { key: "id", header: "ID", shrink: false },
            { key: "name", header: "Name", shrink: false },
            { key: "appearance", header: "Look" },
            { key: "note", header: "Note", format: (_value, row) => themeListNote(row as ReturnType<typeof themeListRows>[number]) },
          ],
        });
        return;
      }
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
          "telemetry.crashReports": context.config.telemetry?.crashReports !== false,
          "telemetry.usage": context.config.telemetry?.usage !== false,
          "telemetry.attention": context.config.telemetry?.attention === true,
          [STAR_PROMPT_CONFIG_KEY]: context.config.starPrompt?.enabled !== false,
        };

        if (action === "list") {
          ctx.printResult({ data: safeConfig }, {
            textColumns: Object.keys(safeConfig).map((key) => ({
              key,
              header: key,
              ...(key === KEYBINDINGS_CONFIG_KEY ? { format: summarizeKeybindings } : {}),
              ...(key === "theme" ? { format: (value: unknown) => describeThemeId(String(value)) } : {}),
            })),
          });
          return;
        }
        if (action === "get") {
          const key = requireArg(args[1], "Usage: gloomberb config get <key>", ctx);
          if (!Object.prototype.hasOwnProperty.call(safeConfig, key)) {
            ctx.fail(`Unknown config key "${key}".`, `Keys: ${Object.keys(safeConfig).join(", ")}`);
          }
          if (key === "theme") {
            const id = String(safeConfig.theme);
            ctx.printResult({ data: { key, value: id, name: themeName(id) } }, {
              text: () => describeThemeId(id),
            });
            return;
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
          if ((isTelemetryConfigKey(key) || key === STAR_PROMPT_CONFIG_KEY) && value !== "true" && value !== "false") {
            ctx.fail(`Usage: gloomberb config set ${key} true|false`);
          }
          // A display name may come unquoted: config set theme White Phosphor.
          const parsedValue = key === "theme"
            ? requireThemeId(args.slice(2).join(" "))
            : key === "refreshIntervalMinutes"
              ? Number(value)
              : isBooleanConfigKey(key)
                ? value === "true"
                : value;
          const nextConfig = isTelemetryConfigKey(key)
            ? { ...context.config, telemetry: { ...context.config.telemetry, [TELEMETRY_CONFIG_KEYS[key]]: parsedValue as boolean } }
            : key === STAR_PROMPT_CONFIG_KEY
              ? { ...context.config, starPrompt: { ...context.config.starPrompt, enabled: parsedValue as boolean } }
              : { ...context.config, [key]: parsedValue };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
          ctx.printResult({
            data: {
              changed: !ctx.cliOptions.dryRun,
              dryRun: ctx.cliOptions.dryRun,
              key,
              value: parsedValue,
              ...(key === "theme" ? { name: themeName(String(parsedValue)) } : {}),
            },
          }, {
            text: (data) => `Set ${key} to ${key === "theme" ? describeThemeId(String(data.value)) : describeConfigValue(data.value)}.${dryRunNote(data.dryRun)}`,
          });
          return;
        }
        ctx.fail("Usage: gloomberb config list|get|set|themes");
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
          "doctor checks an installed or linked plugin the way the app and the desktop build will: entry, the Gloomberb it declares, removed or deprecated imports, export, id, targets, declared hosts, and the browser bundle. Run it before publishing.",
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
        const { linkPlugin } = await import("../../plugins/installer");
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
          // A retired id that now names a group of built-ins switches all of them.
          const targetIds = builtinPluginGroupMembers(id) ?? [id];
          for (const targetId of targetIds) {
            const plugin = services.services.pluginRegistry.allPlugins.get(targetId);
            if (!plugin) ctx.fail(`Plugin "${targetId}" is not available.`);
            if (plugin?.toggleable !== true) ctx.fail(`Plugin "${targetId}" is part of the application and cannot be disabled.`);
          }
          const disabled = new Set(services.config.disabledPlugins ?? []);
          const isOff = () => targetIds.every((targetId) => disabled.has(targetId));
          const isOn = () => targetIds.every((targetId) => !disabled.has(targetId));
          const unchanged = action === "enable" ? isOn() : isOff();
          for (const targetId of targetIds) {
            if (action === "enable") disabled.delete(targetId);
            else disabled.add(targetId);
          }
          const nextConfig = { ...services.config, disabledPlugins: [...disabled] };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
          ctx.printResult({ data: { changed: !unchanged && !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, id, enabled: isOn() } }, {
            text: (data) => {
              const state = data.enabled ? "on" : "off";
              if (unchanged) return `${id} is already ${state}.`;
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

  return [
    versionCommand,
    doctorCommand,
    configCommand,
    cacheCommand,
    providerCommand,
    pluginCommand,
    layoutCommand,
    paneCommand,
  ];
}
