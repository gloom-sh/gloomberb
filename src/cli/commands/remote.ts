import { getDataDir } from "../../data/config/store";
import type { CliCommandContext, CliCommandDef } from "../../types/plugin";
import { sendRemoteControlRequest } from "../../remote/client";
import type { RemoteAppKind, RemoteControlRequest, RemoteControlResponse } from "../../remote/types";
import { CLI_COMMAND_GROUPS } from "../help";

interface RemoteArgs {
  args: string[];
  appKind?: RemoteAppKind;
  expectRev?: string;
  intervalMs: number;
}

export const remoteCliCommand: CliCommandDef = {
  name: "remote",
  description: "Drive a running gloomberb app through its remote API",
  help: {
    group: CLI_COMMAND_GROUPS.app,
    usage: [
      "remote schema",
      "remote help",
      "remote get <resource>",
      "remote call <operation> [json]",
      "remote patch <resource> <json-patch> [--expect-rev <rev>]",
      "remote batch <json>",
      "remote watch <resource> [--interval <ms>]",
    ],
    options: [
      { flags: "--app <app>", description: "tui or desktop, when both are running" },
      { flags: "--expect-rev <rev>", description: "Refuse the patch unless the resource is still at this revision" },
      { flags: "--interval <ms>", description: "How often watch polls, at least 100 (default 1000)" },
      { flags: "--dry-run", description: "Check a call, patch, or batch without applying it" },
    ],
    examples: ["remote schema", "remote get layout", "remote watch layout --limit 5"],
  },
  execute: async (rawArgs, ctx) => {
    const parsed = parseRemoteArgs(rawArgs);
    const action = parsed.args[0];
    if (!action) {
      ctx.fail("Usage: gloomberb remote <schema|help|get|call|patch|batch|watch>");
      return;
    }

    const dataDir = await getDataDir();
    if (!dataDir) {
      ctx.fail("No data directory configured.", "Run gloomberb once before using remote control.");
      return;
    }

    if (action === "watch") {
      const resource = parsed.args[1];
      if (!resource) {
        ctx.fail("Usage: gloomberb remote watch <resource>");
        return;
      }
      const limit = ctx.cliOptions.limit ?? Number.POSITIVE_INFINITY;
      for (let index = 0; index < limit; index += 1) {
        const response = await sendRemoteControlRequest({ type: "get", resource }, {
          dataDir,
          appKind: parsed.appKind,
        });
        printRemoteResponse(response, ctx);
        if (index < limit - 1) await new Promise((resolve) => setTimeout(resolve, parsed.intervalMs));
      }
      return;
    }

    const request = buildRemoteRequest(action, parsed, ctx.cliOptions.dryRun);
    const response = await sendRemoteControlRequest(request, {
      dataDir,
      appKind: parsed.appKind,
    });
    printRemoteResponse(response, ctx);
  },
};

function parseRemoteArgs(rawArgs: string[]): RemoteArgs {
  const args: string[] = [];
  let appKind: RemoteAppKind | undefined;
  let expectRev: string | undefined;
  let intervalMs = 1_000;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--app") {
      index += 1;
      appKind = parseAppKind(rawArgs[index]);
      continue;
    }
    if (arg.startsWith("--app=")) {
      appKind = parseAppKind(arg.slice("--app=".length));
      continue;
    }
    if (arg === "--expect-rev") {
      index += 1;
      expectRev = rawArgs[index];
      if (!expectRev) throw new Error("Missing value for --expect-rev.");
      continue;
    }
    if (arg.startsWith("--expect-rev=")) {
      expectRev = arg.slice("--expect-rev=".length);
      continue;
    }
    if (arg === "--interval") {
      index += 1;
      intervalMs = parseInterval(rawArgs[index]);
      continue;
    }
    if (arg.startsWith("--interval=")) {
      intervalMs = parseInterval(arg.slice("--interval=".length));
      continue;
    }
    args.push(arg);
  }

  return { args, appKind, expectRev, intervalMs };
}

function buildRemoteRequest(action: string, parsed: RemoteArgs, dryRun: boolean): RemoteControlRequest {
  switch (action) {
    case "schema":
      return { type: "schema" };
    case "help":
      return { type: "help" };
    case "get": {
      const resource = parsed.args[1];
      if (!resource) throw new Error("Usage: gloomberb remote get <resource>");
      return { type: "get", resource };
    }
    case "call": {
      const operation = parsed.args[1];
      if (!operation) throw new Error("Usage: gloomberb remote call <operation> [json]");
      return {
        type: "call",
        operation,
        input: parseJsonValue(parsed.args[2], {}),
        dryRun,
      };
    }
    case "patch": {
      const resource = parsed.args[1];
      const patchRaw = parsed.args[2];
      if (!resource || !patchRaw) throw new Error("Usage: gloomberb remote patch <resource> <json-patch>");
      const patch = parseJsonValue(patchRaw, []);
      if (!Array.isArray(patch)) throw new Error("Remote patch payload must be a JSON array.");
      return {
        type: "patch",
        resource,
        patch,
        expectRev: parsed.expectRev,
        dryRun,
      };
    }
    case "batch": {
      const payload = parseJsonValue(parsed.args[1], null);
      if (!payload) throw new Error("Usage: gloomberb remote batch <json>");
      if (Array.isArray(payload)) return { type: "batch", requests: payload as RemoteControlRequest[], dryRun };
      return withCliDryRun(payload as RemoteControlRequest, dryRun);
    }
    default:
      throw new Error(`Unknown remote action "${action}".`);
  }
}

function withCliDryRun(request: RemoteControlRequest, dryRun: boolean): RemoteControlRequest {
  if (!dryRun) return request;
  if (request.type === "batch") return { ...request, dryRun: true };
  if (request.type === "call" || request.type === "patch") return { ...request, dryRun: true };
  return request;
}

function parseAppKind(value: string | undefined): RemoteAppKind {
  if (value === "tui" || value === "desktop") return value;
  throw new Error("--app must be either tui or desktop.");
}

function parseInterval(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100) {
    throw new Error("--interval must be an integer >= 100.");
  }
  return parsed;
}

function parseJsonValue<T>(raw: string | undefined, fallback: T): unknown {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printRemoteResponse(
  response: RemoteControlResponse,
  ctx: CliCommandContext,
): void {
  if (!response.ok) {
    const details = response.error.details == null
      ? undefined
      : typeof response.error.details === "string"
        ? response.error.details
        : JSON.stringify(response.error.details, null, 2);
    ctx.fail(response.error.message, details);
    return;
  }
  const data = response.state ? { data: response.data, state: response.state } : response.data;
  ctx.printResult({
    data,
    metadata: response.rev ? { rev: response.rev } : undefined,
    warnings: response.warnings,
  }, {
    text: (data) => JSON.stringify(data, null, 2),
  });
}
