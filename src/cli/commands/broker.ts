import type { CliCommandDef } from "../../types/plugin";
import { withCliServices } from "../context";
import { takeOption } from "./command-utils";
import { CLI_COMMAND_GROUPS } from "../help";

export const brokerCliCommand: CliCommandDef = {
  name: "broker",
  aliases: ["brokers"],
  description: "List connected broker accounts",
  help: {
    group: CLI_COMMAND_GROUPS.portfolios,
    usage: ["broker list [--type <broker>]"],
    options: [{ flags: "--type <broker>", description: "Only one kind of broker, as shown in the type column" }],
    examples: ["broker list", "broker list --type ibkr"],
  },
  execute: async (rawArgs, ctx) => {
    const args = [...rawArgs];
    const type = takeOption(args, "--type");
    const action = args[0] ?? "list";
    if (action !== "list" && action !== "status") {
      ctx.fail("Usage: gloomberb broker list|status [--type <broker>]");
    }
    await withCliServices(ctx, async (services) => {
      ctx.printResult({
        data: services.config.brokerInstances
          .filter((instance) => !type || instance.brokerType === type)
          .map((instance) => ({
            id: instance.id,
            type: instance.brokerType,
            label: instance.label,
            enabled: instance.enabled !== false,
            connectionMode: instance.connectionMode ?? "",
            lastSyncedAt: instance.lastSyncedAt ? new Date(instance.lastSyncedAt).toISOString() : "",
          })),
      }, {
        empty: type
          ? `No ${type} brokers connected.`
          : "No brokers connected. Add one from the Broker pane in the app.",
      });
    });
  },
};

/** `gloomberb ibkr` predates `broker list --type`; old scripts still run it, but help leaves it out. */
export const ibkrCliCommand: CliCommandDef = {
  name: "ibkr",
  description: "List Interactive Brokers profiles, like broker list --type ibkr",
  execute: (_args, ctx) => brokerCliCommand.execute(["list", "--type", "ibkr"], ctx),
};
