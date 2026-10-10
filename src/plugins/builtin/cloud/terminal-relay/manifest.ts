import {
  REMOTE_OPERATIONS,
  REMOTE_RESOURCES,
  remoteOperationToolName,
} from "../../../../remote/schema";
import type {
  RemoteJsonSchema,
  RemoteSideEffectLevel,
  RemoteWriteTier,
} from "../../../../remote/types";
import {
  operationPolicy,
  patchPolicy,
  policySentence,
  tierLabel,
  type TerminalRelayPolicy,
} from "./policy";

/**
 * The tools this app runs for a remote assistant, generated from the remote
 * API schema: every operation is a tool, so a new operation reaches the
 * assistant without anyone listing it. Gloom Cloud advertises these as
 * `terminal.<name>` and adds its own `terminal.devices` and
 * `terminal.call_result`.
 */
export const TERMINAL_RELAY_PROTOCOL = 1;

export type TerminalRelayToolKind =
  | { kind: "operation"; operation: string }
  | { kind: "resource" }
  | { kind: "patch" }
  | { kind: "data" }
  | { kind: "snapshot" }
  | { kind: "pane-content" };

export interface TerminalRelayToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: RemoteJsonSchema;
  tier: RemoteSideEffectLevel;
  writeTier: RemoteWriteTier;
  policy: TerminalRelayPolicy;
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
  };
}

interface TerminalRelayTool extends TerminalRelayToolDescriptor {
  binding: TerminalRelayToolKind;
}

const DESTRUCTIVE_OPERATIONS = new Set(["layout.delete", "pane.close", "layout.closeFloating", "desktop.closeDetachedPane"]);
const IDEMPOTENT_OPERATIONS = new Set([
  "pane.show",
  "pane.focus",
  "ticker.select",
  "ticker.switchTab",
  "layout.switch",
  "layout.focusRegion",
  "layout.setGrid",
  "app.closeCommandBar",
]);

function describe(text: string, tier: RemoteSideEffectLevel, policy: TerminalRelayPolicy): string {
  return `${text} Tier: ${tierLabel(tier)}. ${policySentence(policy)}`;
}

function readTool(
  name: string,
  title: string,
  text: string,
  inputSchema: RemoteJsonSchema,
  binding: TerminalRelayToolKind,
): TerminalRelayTool {
  return {
    name,
    title,
    description: describe(text, "none", "allow"),
    inputSchema,
    tier: "none",
    writeTier: "read",
    policy: "allow",
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    binding,
  };
}

const RESOURCE_LIST = REMOTE_RESOURCES.map(({ uri }) => uri).join(", ");

function buildTools(): TerminalRelayTool[] {
  const operations = REMOTE_OPERATIONS.map((operation): TerminalRelayTool => {
    const { policy } = operationPolicy(operation.id);
    const external = operation.sideEffectLevel === "external-side-effect"
      || operation.sideEffectLevel === "external-trade"
      || operation.sideEffectLevel === "network-write";
    return {
      name: remoteOperationToolName(operation.id),
      title: operation.title,
      description: describe(operation.description, operation.sideEffectLevel, policy),
      inputSchema: operation.inputSchema,
      tier: operation.sideEffectLevel,
      writeTier: operation.writeTier,
      policy,
      annotations: {
        readOnly: operation.sideEffectLevel === "none",
        destructive: DESTRUCTIVE_OPERATIONS.has(operation.id) || operation.writeTier === "user-data" || external,
        idempotent: IDEMPOTENT_OPERATIONS.has(operation.id),
        openWorld: external,
      },
      binding: { kind: "operation", operation: operation.id },
    };
  });
  return [
    readTool(
      "snapshot",
      "Terminal: Snapshot",
      "What is on screen: the active layout and the saved layouts, every pane with its placement, the focused pane and its ticker, the command bar and any open form.",
      { type: "object", properties: {}, additionalProperties: false },
      { kind: "snapshot" },
    ),
    readTool(
      "pane_content",
      "Terminal: Pane content",
      "What one pane shows: its settings and runtime state, and the semantic UI nodes drawn in it (table rows, tabs, lists, buttons, chart data). paneId is an instance id from terminal.snapshot.",
      {
        type: "object",
        properties: { paneId: { type: "string", minLength: 1 } },
        required: ["paneId"],
        additionalProperties: false,
      },
      { kind: "pane-content" },
    ),
    readTool(
      "get_resource",
      "Terminal: Get resource",
      `Read one remote API resource. Resources: ${RESOURCE_LIST}. Configuration arrives with credentials removed.`,
      {
        type: "object",
        properties: { resource: { type: "string", minLength: 1, description: "A resource URI, such as app://panes or app://pane-state/{paneId}." } },
        required: ["resource"],
        additionalProperties: false,
      },
      { kind: "resource" },
    ),
    readTool(
      "market_data",
      "Terminal: Market data",
      "Market data through the terminal's own sources: search, quote, financials, secFilings, holders, analystResearch, corporateActions, earningsCalendar.",
      {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["search", "quote", "financials", "secFilings", "holders", "analystResearch", "corporateActions", "earningsCalendar"],
          },
          query: { type: "string" },
          symbol: { type: "string" },
          exchange: { type: "string" },
          count: { type: "integer", minimum: 1 },
          symbols: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      { kind: "data" },
    ),
    {
      name: "patch_resource",
      title: "Terminal: Patch resource",
      description: `Apply a JSON Patch to a mutable resource: app://layout/current, app://pane-state/{paneId}, app://pane-settings/{paneId} or app://config. Pass expectRev from a read so a stale edit fails. Tier: local-write. ${policySentence(patchPolicy("app://layout/current").policy)} Patching app://config is confirmed by the person on each call.`,
      inputSchema: {
        type: "object",
        properties: {
          resource: { type: "string", minLength: 1 },
          patch: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "replace", "remove"] },
                path: { type: "string" },
                value: {},
              },
              required: ["op", "path"],
              additionalProperties: false,
            },
          },
          expectRev: { type: "string" },
        },
        required: ["resource", "patch"],
        additionalProperties: false,
      },
      tier: "local-write",
      writeTier: "ui-write",
      policy: "allow",
      annotations: { readOnly: false, destructive: true, idempotent: false, openWorld: false },
      binding: { kind: "patch" },
    },
    ...operations,
  ];
}

const TOOLS = buildTools();
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** What the app announces to Gloom Cloud. */
export function terminalRelayToolDescriptors(): TerminalRelayToolDescriptor[] {
  return TOOLS.map(({ binding: _binding, ...descriptor }) => descriptor);
}

/** The app's own table: a name it did not generate is never run. */
export function resolveTerminalRelayTool(name: string): TerminalRelayToolKind | null {
  return TOOLS_BY_NAME.get(name)?.binding ?? null;
}

export function terminalRelayToolTitle(name: string): string {
  return TOOLS_BY_NAME.get(name)?.title ?? name;
}

function resourcePatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`).test(value);
}

export function isKnownRemoteResource(resource: string): boolean {
  return REMOTE_RESOURCES.some(({ uri }) => resourcePatternMatches(uri, resource));
}
