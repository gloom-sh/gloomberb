import { withConfigData } from "../../../cli/scoped-context";
import { CLI_COMMAND_GROUPS } from "../../../cli/help";
import { dryRunNote } from "../../../cli/helpers";
import { requireArg, takeOption } from "../../../cli/commands/command-utils";
import { EXCHANGE_OPTION, requireListingArg } from "../../../cli/listing-arg";
import { saveConfig } from "../../../data/config/store";
import type { CliCommandDef } from "../../../types/plugin";
import { cliStyles } from "../../../utils/cli-output";
import { createAlert, deserializeAlerts, rearmAlert, serializeAlerts } from "./alert-engine";
import { ALERTS_KEY } from "./constants";
import type { AlertCondition } from "./types";

const ALERTS_PLUGIN_ID = "alerts";

export const alertsCliCommand: CliCommandDef = {
  name: "alerts",
  aliases: ["alert"],
  description: "List, add, and remove price alerts",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: ["alerts list", "alerts add <symbol> <above|below|crosses> <price>", "alerts delete <id>", "alerts rearm <id>"],
    options: [EXCHANGE_OPTION],
    examples: ["alerts", "alerts add AAPL above 250", "alerts add SAN:EPA below 70", "alerts add BTC-USD below 60000"],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const exchange = takeOption(args, "--exchange");
    const action = args[0] ?? "list";
    const listing = action === "add" && args[1] ? await requireListingArg(args[1], exchange, ctx) : null;
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
        const symbol = requireArg(listing?.key, "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx);
        const condition = requireArg(args[2], "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx) as AlertCondition;
        if (!["above", "below", "crosses"].includes(condition)) ctx.fail("Condition must be above, below, or crosses.");
        const price = Number(requireArg(args[3], "Usage: gloomberb alerts add <symbol> <above|below|crosses> <price>", ctx));
        if (!Number.isFinite(price)) ctx.fail("Alert price must be a finite number.");
        const alert = createAlert(symbol, condition, price, listing?.exchange);
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
        const next = alerts.map((alert) => alert.id === id ? rearmAlert(alert) : alert);
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
