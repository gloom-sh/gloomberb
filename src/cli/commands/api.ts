import type { CliCommandDef } from "../../types/plugin";
import { withCliServices } from "../context";
import { parseJsonPayload, requireArg, takeOption } from "./command-utils";

function splitOperationTarget(target: string): { capabilityId: string; operationId: string } {
  const separator = target.lastIndexOf(".");
  if (separator <= 0 || separator === target.length - 1) {
    throw new Error("Use <capability-id>.<operation-id>.");
  }
  return {
    capabilityId: target.slice(0, separator),
    operationId: target.slice(separator + 1),
  };
}

function parseOperationTarget(target: string, ctx: Parameters<CliCommandDef["execute"]>[1]) {
  try {
    return splitOperationTarget(target);
  } catch (error) {
    ctx.fail("Invalid capability operation target.", error instanceof Error ? error.message : String(error));
  }
}

export const apiCliCommand: CliCommandDef = {
  name: "api",
  description: "List, inspect, invoke, or subscribe to plugin capabilities",
  help: {
    usage: [
      "api list [--kind kind]",
      "api get <capability-id>",
      "api invoke <capability.operation> [json-payload]",
      "api subscribe <capability.operation> [json-payload] [--limit n]",
    ],
  },
  execute: async (rawArgs, ctx) => {
    const action = rawArgs[0] ?? "list";
    const args = rawArgs.slice(1);
    await withCliServices(ctx, async (services) => {
      if (action === "list") {
        const kind = takeOption(args, "--kind");
        const manifests = services.services.pluginRegistry.capabilities
          .manifests()
          .filter((manifest) => !kind || manifest.kind === kind);
        ctx.printResult({ data: manifests }, {
          rows: (data) => data.map((manifest) => ({
            id: manifest.id,
            kind: manifest.kind,
            name: manifest.name,
            operations: manifest.operations.map((operation) => operation.id).join(", "),
          })),
          columns: [
            { key: "id", header: "Capability" },
            { key: "kind", header: "Kind" },
            { key: "name", header: "Name" },
            { key: "operations", header: "Operations" },
          ],
        });
        return;
      }

      if (action === "get") {
        const capabilityId = requireArg(args[0], "Usage: gloomberb api get <capability-id>", ctx);
        const manifest = services.services.pluginRegistry.capabilities
          .manifests()
          .find((entry) => entry.id === capabilityId);
        if (!manifest) ctx.fail(`Capability "${capabilityId}" is not available.`);
        ctx.printResult({ data: manifest });
        return;
      }

      if (action === "invoke") {
        const target = requireArg(args[0], "Usage: gloomberb api invoke <capability.operation> [json-payload]", ctx);
        const operationTarget = parseOperationTarget(target, ctx);
        const payload = parseJsonPayload(args[1], ctx);
        const data = await services.services.pluginRegistry.capabilities.invoke(
          operationTarget.capabilityId,
          operationTarget.operationId,
          payload,
        );
        ctx.printResult({ data });
        return;
      }

      if (action === "subscribe") {
        const target = requireArg(args[0], "Usage: gloomberb api subscribe <capability.operation> [json-payload] [--limit n]", ctx);
        const operationTarget = parseOperationTarget(target, ctx);
        const limit = ctx.cliOptions.limit ?? 10;
        const payload = parseJsonPayload(args[1], ctx);
        let count = 0;
        let subscriptionId: string | null = null;
        await new Promise<void>(async (resolve, reject) => {
          try {
            subscriptionId = await services.services.pluginRegistry.capabilities.subscribe(
              operationTarget.capabilityId,
              operationTarget.operationId,
              payload,
              (event) => {
                count += 1;
                ctx.printResult({ data: event });
                if (count >= limit && subscriptionId) {
                  services.services.pluginRegistry.capabilities.unsubscribe(subscriptionId);
                  resolve();
                }
              },
            );
          } catch (error) {
            reject(error);
          }
        });
        return;
      }

      ctx.fail("Usage: gloomberb api list|get|invoke|subscribe");
    });
  },
};
