import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { VERSION } from "../../version";
import { saveConfig } from "../../data/config/store";
import { NotesFiles } from "../../plugins/builtin/notes/files";
import { createAlert, deserializeAlerts, serializeAlerts } from "../../plugins/builtin/alerts/alert-engine";
import type { AlertCondition } from "../../plugins/builtin/alerts/types";
import type { CliCommandDef } from "../../types/plugin";
import { debugLog, type LogLevel } from "../../utils/debug-log";
import { withCliServices, withConfigData } from "../context";
import { parsePositiveInt, requireArg, takeOption } from "./command-utils";

const ALERTS_PLUGIN_ID = "alerts";
const ALERTS_KEY = "alerts";
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function commandRows(commands: CliCommandDef[]) {
  return commands.map((command) => ({
    name: command.name,
    aliases: command.aliases?.join(",") ?? "",
    description: command.description,
  }));
}

function parseLogLevel(value: string | undefined): LogLevel | undefined {
  return value && LOG_LEVELS.has(value as LogLevel) ? value as LogLevel : undefined;
}

function resourceCacheStats(services: Awaited<ReturnType<Parameters<CliCommandDef["execute"]>[1]["initServices"]>>) {
  const row = services.persistence.database.connection
    .query<{ count: number; size: number; expired: number; stale: number }, []>(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(size_bytes), 0) as size,
              SUM(CASE WHEN expires_at < strftime('%s','now') * 1000 THEN 1 ELSE 0 END) as expired,
              SUM(CASE WHEN stale_at < strftime('%s','now') * 1000 THEN 1 ELSE 0 END) as stale
       FROM resource_cache`,
    )
    .get();
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
    description: "Print version and runtime information",
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
      });
    },
  };

  const doctorCommand: CliCommandDef = {
    name: "doctor",
    description: "Check local CLI runtime, config, plugins, and capability health",
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
          { key: "status", header: "Status" },
          { key: "detail", header: "Detail" },
        ],
      });
    },
  };

  const configCommand: CliCommandDef = {
    name: "config",
    description: "Inspect and update local configuration",
    help: { usage: ["config list", "config get <key>", "config set <key> <value>"] },
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
        };

        if (action === "list") {
          ctx.printResult({ data: safeConfig });
          return;
        }
        if (action === "get") {
          const key = requireArg(args[1], "Usage: gloomberb config get <key>", ctx);
          ctx.printResult({
            data: {
              key,
              value: Object.prototype.hasOwnProperty.call(safeConfig, key) ? safeConfig[key] : null,
            },
          });
          return;
        }
        if (action === "set") {
          const key = requireArg(args[1], "Usage: gloomberb config set <key> <value>", ctx);
          const value = requireArg(args[2], "Usage: gloomberb config set <key> <value>", ctx);
          const editable = new Set(["baseCurrency", "refreshIntervalMinutes", "theme", "valueFlashingEnabled"]);
          if (!editable.has(key)) ctx.fail(`Config key "${key}" is not editable from the CLI.`);
          const parsedValue = key === "refreshIntervalMinutes"
            ? Number(value)
            : key === "valueFlashingEnabled"
              ? value === "true"
              : value;
          const nextConfig = { ...context.config, [key]: parsedValue };
          if (!ctx.cliOptions.dryRun) await saveConfig(nextConfig);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, key, value: parsedValue } });
          return;
        }
        ctx.fail("Usage: gloomberb config list|get|set");
      });
    },
  };

  const cacheCommand: CliCommandDef = {
    name: "cache",
    description: "Inspect or clear the resource cache",
    help: { usage: ["cache status", "cache clear [namespace]"] },
    execute: async (args, ctx) => {
      const action = args[0] ?? "status";
      await withCliServices(ctx, async (services) => {
        if (action === "status") {
          ctx.printResult({ data: [resourceCacheStats(services)] });
          return;
        }
        if (action === "clear") {
          const namespace = args[1];
          const before = resourceCacheStats(services);
          if (!ctx.cliOptions.dryRun) services.persistence.resources.clear(namespace);
          const after = ctx.cliOptions.dryRun ? before : resourceCacheStats(services);
          ctx.printResult({ data: [{ changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, namespace: namespace ?? "all", before: before.entries, after: after.entries }] });
          return;
        }
        ctx.fail("Usage: gloomberb cache status|clear");
      });
    },
  };

  const providerCommand: CliCommandDef = {
    name: "provider",
    aliases: ["providers"],
    description: "Inspect provider/source capability status",
    help: { usage: ["provider status"] },
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
        });
      });
    },
  };

  const pluginCommand: CliCommandDef = {
    name: "plugin",
    description: "Inspect, enable, disable, or doctor plugins",
    help: { usage: ["plugin list", "plugin info <id>", "plugin enable <id>", "plugin disable <id>", "plugin doctor"] },
    execute: async (args, ctx) => {
      const action = args[0] ?? "list";
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

        if (action === "list" || action === "doctor") {
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
          ctx.printResult({ data: { changed: before !== disabled.has(id) && !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, id, enabled: !disabled.has(id) } });
          return;
        }
        ctx.fail("Usage: gloomberb plugin list|info|enable|disable|doctor");
      });
    },
  };

  const layoutCommand: CliCommandDef = {
    name: "layout",
    description: "Inspect saved layouts",
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
    description: "Inspect pane and pane-template inventory",
    help: { usage: ["pane list"] },
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
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "owner", header: "Owner" },
          ],
        });
      });
    },
  };

  const notesCommand: CliCommandDef = {
    name: "notes",
    description: "Read and mutate ticker or quick notes",
    help: { usage: ["notes show <symbol>", "notes set <symbol> TEXT", "notes delete <symbol>", "notes quick list"] },
    execute: async (args, ctx) => {
      await withConfigData(ctx, async (config) => {
        const notes = new NotesFiles(config.dataDir);
        const action = args[0] ?? "list";
        if (action === "quick") {
          const subaction = args[1] ?? "list";
          if (subaction !== "list") ctx.fail("Usage: gloomberb notes quick list");
          const entries = await notes.loadQuickNotesIndex();
          ctx.printResult({ data: entries });
          return;
        }
        if (action === "show") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes show <symbol>", ctx);
          ctx.printResult({ data: { symbol, text: await notes.load(symbol) } });
          return;
        }
        if (action === "set") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes set <symbol> TEXT", ctx);
          const text = args.slice(2).join(" ");
          if (!ctx.cliOptions.dryRun) await notes.save(symbol, text);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol, bytes: text.length } });
          return;
        }
        if (action === "delete" || action === "rm") {
          const symbol = requireArg(args[1]?.toUpperCase(), "Usage: gloomberb notes delete <symbol>", ctx);
          if (!ctx.cliOptions.dryRun) await notes.delete(symbol);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, symbol } });
          return;
        }
        ctx.fail("Usage: gloomberb notes show|set|delete|quick");
      });
    },
  };

  const alertsCommand: CliCommandDef = {
    name: "alerts",
    aliases: ["alert"],
    description: "List and manage price alerts",
    help: { usage: ["alerts list", "alerts add <symbol> <above|below|crosses> <price>", "alerts delete <id>", "alerts rearm <id>"] },
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
          ctx.printResult({ data: alerts });
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
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, alert } });
          return;
        }
        if (action === "delete" || action === "rm") {
          const id = requireArg(args[1], "Usage: gloomberb alerts delete <id>", ctx);
          const next = alerts.filter((alert) => alert.id !== id);
          await saveAlerts(next);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun && next.length !== alerts.length, dryRun: ctx.cliOptions.dryRun, id } });
          return;
        }
        if (action === "rearm") {
          const id = requireArg(args[1], "Usage: gloomberb alerts rearm <id>", ctx);
          const next = alerts.map((alert) => alert.id === id ? { ...alert, status: "active" as const, triggeredAt: undefined } : alert);
          await saveAlerts(next);
          ctx.printResult({ data: { changed: !ctx.cliOptions.dryRun, dryRun: ctx.cliOptions.dryRun, id } });
          return;
        }
        ctx.fail("Usage: gloomberb alerts list|add|delete|rearm");
      });
    },
  };

  const debugCommand: CliCommandDef = {
    name: "debug",
    description: "Inspect, export, clear, or tail in-memory debug logs",
    help: { usage: ["debug logs", "debug export [--output path]", "debug clear", "debug tail [--limit n]"] },
    execute: async (rawArgs, ctx) => {
      const args = [...rawArgs];
      const action = args[0] ?? "logs";
      const source = takeOption(args, "--source");
      const level = parseLogLevel(takeOption(args, "--level"));
      if (action === "clear") {
        debugLog.clear();
        ctx.printResult({ data: { changed: true } });
        return;
      }
      if (action === "export") {
        const output = takeOption(args, "--output");
        const text = debugLog.exportAsText({ source, level });
        if (output) writeFileSync(output, text);
        ctx.printResult({ data: { output: output ?? null, bytes: text.length, text: output ? undefined : text } });
        return;
      }
      const entries = debugLog.getEntries({ source, level }).slice(-(ctx.cliOptions.limit ?? 50));
      ctx.printResult({ data: entries }, {
        columns: [
          { key: "id", header: "ID", align: "right" },
          { key: "timestamp", header: "Time", value: (row) => new Date(Number(row.timestamp)).toISOString() },
          { key: "level", header: "Level" },
          { key: "source", header: "Source" },
          { key: "message", header: "Message" },
        ],
      });
    },
  };

  const changelogCommand: CliCommandDef = {
    name: "changelog",
    description: "Print local changelog or release notes when available",
    execute: async (args, ctx) => {
      const limit = parsePositiveInt(args[0], ctx.cliOptions.limit ?? 80, "Line count", ctx);
      const candidates = ["CHANGELOG.md", "CHANGELOG", "RELEASE_NOTES.md", "README.md"];
      const found = candidates.find((candidate) => existsSync(candidate));
      const text = found ? readFileSync(found, "utf8").split("\n").slice(0, limit).join("\n") : "";
      ctx.printResult({ data: { path: found ?? null, text, version: VERSION } });
    },
  };

  const commandCatalogCommand: CliCommandDef = {
    name: "command",
    aliases: ["commands"],
    description: "List registered first-class CLI commands",
    execute: (_args, ctx) => {
      ctx.printResult({ data: commandRows(allCommands()) }, {
        columns: [
          { key: "name", header: "Command" },
          { key: "aliases", header: "Aliases" },
          { key: "description", header: "Description" },
        ],
      });
    },
  };

  const coverageCommand: CliCommandDef = {
    name: "coverage",
    description: "Show CLI coverage for panes, templates, capabilities, and deferred exceptions",
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
            { key: "id", header: "ID" },
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
