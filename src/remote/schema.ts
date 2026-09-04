import type {
  RemoteControlSchema,
  RemoteJsonSchema,
  RemoteOperationDescriptor,
  RemoteOperationSchema,
  RemoteResourceSchema,
  RemoteSideEffectLevel,
  RemoteWriteTier,
} from "./types";

export const REMOTE_RESOURCES: RemoteResourceSchema[] = [
  { uri: "app://snapshot", description: "Current app snapshot including layout, focus, panes, command bar, and plugin/capability catalogs." },
  { uri: "app://config", description: "Current app config.", patchable: true },
  { uri: "app://layout/current", description: "Current active layout.", patchable: true },
  { uri: "app://layouts", description: "Saved layouts." },
  { uri: "app://panes", description: "Current pane instances with placement and runtime state." },
  { uri: "app://pane-types", description: "Registered pane types from core and plugins." },
  { uri: "app://pane-templates", description: "Registered pane templates from core and plugins." },
  { uri: "app://pane-state/{paneId}", description: "Runtime state for a pane instance.", patchable: true },
  { uri: "app://pane-settings/{paneId}", description: "Persisted settings for a pane instance.", patchable: true },
  { uri: "app://commands", description: "Registered command-bar commands." },
  { uri: "app://command-bar", description: "Current command-bar state and semantic result rows." },
  { uri: "app://command-bar/results", description: "Current semantic command-bar result rows." },
  { uri: "app://capabilities", description: "Registered plugin capability manifests." },
  { uri: "app://auth", description: "What the client believes about its cloud session: credential present, checked, cached user plan and verification. No secrets." },
  { uri: "app://remote/help", description: "Agent-oriented remote usage guide with efficient recipes and caveats." },
  { uri: "ui://tree", description: "Live semantic UI node tree populated by shared controls and interactive primitives." },
];

const stringSchema = { type: "string" } satisfies RemoteJsonSchema;
const requiredStringSchema = { type: "string", minLength: 1 } satisfies RemoteJsonSchema;
const booleanSchema = { type: "boolean" } satisfies RemoteJsonSchema;
const indexSchema = { type: "integer", minimum: 0 } satisfies RemoteJsonSchema;
const openObjectSchema = { type: "object", additionalProperties: true } satisfies RemoteJsonSchema;
const anySchema = {} satisfies RemoteJsonSchema;

function objectSchema(
  properties: Record<string, RemoteJsonSchema> = {},
  required: string[] = [],
): RemoteJsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const paneIdInput = objectSchema({ paneId: requiredStringSchema }, ["paneId"]);

export const REMOTE_OPERATIONS: RemoteOperationSchema[] = [
  op(
    "app.openCommandBar",
    "Open the command bar with an optional query and optional mode.",
    "{ query?: string, mode?: 'command' | 'ticker' | 'default' }",
    "local-write",
    objectSchema({
      query: stringSchema,
      mode: { type: "string", enum: ["command", "ticker", "default"] },
    }),
  ),
  op("app.closeCommandBar", "Close the command bar.", "{}", "local-write", objectSchema()),
  op(
    "app.setCommandBarQuery",
    "Set the command bar query.",
    "{ query: string }",
    "local-write",
    objectSchema({ query: requiredStringSchema }, ["query"]),
  ),
  op(
    "app.search",
    "Open command-bar search without requiring UI prefix syntax.",
    "{ mode?: 'command' | 'ticker' | 'default', query?: string }",
    "local-write",
    objectSchema({
      mode: { type: "string", enum: ["command", "ticker", "default"] },
      query: stringSchema,
    }),
  ),
  op(
    "app.switchPanel",
    "Switch the active panel.",
    "{ panel: 'left' | 'right' }",
    "local-write",
    objectSchema({ panel: { type: "string", enum: ["left", "right"] } }, ["panel"]),
  ),
  op(
    "app.notify",
    "Show an in-app notification.",
    "{ body: string, type?: 'info' | 'success' | 'error' }",
    "local-write",
    objectSchema({
      body: requiredStringSchema,
      type: { type: "string", enum: ["info", "success", "error"] },
    }, ["body"]),
  ),
  op(
    "commandBar.activateResult",
    "Activate a visible command-bar result by zero-based index, node id, item id, or label.",
    "{ index?: number, nodeId?: string, itemId?: string, label?: string }",
    "local-write",
    objectSchema({ index: indexSchema, nodeId: stringSchema, itemId: stringSchema, label: stringSchema }),
  ),
  op("pane.show", "Show or focus a pane type.", "{ paneId: string }", "local-write", paneIdInput),
  op("pane.focus", "Focus a pane instance or pane type.", "{ paneId: string }", "local-write", paneIdInput),
  op("pane.close", "Close a pane instance or pane type.", "{ paneId: string }", "local-write", paneIdInput),
  op(
    "pane.createFromTemplate",
    "Create a pane from a registered template.",
    "{ templateId: string, options?: object }",
    "local-write",
    objectSchema({ templateId: requiredStringSchema, options: openObjectSchema }, ["templateId"]),
  ),
  op(
    "pane.setState",
    "Patch pane runtime state.",
    "{ paneId: string, patch: object }",
    "local-write",
    objectSchema({ paneId: requiredStringSchema, patch: openObjectSchema }, ["paneId", "patch"]),
  ),
  op(
    "pane.setSetting",
    "Set one pane setting using the pane's registered setting field when available.",
    "{ paneId: string, key: string, value: any }",
    "local-write",
    objectSchema({ paneId: requiredStringSchema, key: requiredStringSchema, value: anySchema }, ["paneId", "key", "value"]),
  ),
  op(
    "ticker.navigate",
    "Navigate a ticker into the best available ticker research target.",
    "{ symbol: string, sourcePaneId?: string }",
    "local-write",
    objectSchema({ symbol: requiredStringSchema, sourcePaneId: stringSchema }, ["symbol"]),
  ),
  op(
    "ticker.pin",
    "Open or focus a fixed ticker research pane.",
    "{ symbol: string, floating?: boolean, forceNewPane?: boolean, paneType?: string }",
    "local-write",
    objectSchema({
      symbol: requiredStringSchema,
      floating: booleanSchema,
      forceNewPane: booleanSchema,
      paneType: stringSchema,
    }, ["symbol"]),
  ),
  op(
    "ticker.select",
    "Select a ticker in a target pane.",
    "{ symbol: string, paneId?: string }",
    "local-write",
    objectSchema({ symbol: requiredStringSchema, paneId: stringSchema }, ["symbol"]),
  ),
  op(
    "ticker.switchTab",
    "Switch ticker research tab.",
    "{ tabId: string, paneId?: string }",
    "local-write",
    objectSchema({ tabId: requiredStringSchema, paneId: stringSchema }, ["tabId"]),
  ),
  op(
    "layout.switch",
    "Switch active layout by index.",
    "{ index: number }",
    "local-write",
    objectSchema({ index: indexSchema }, ["index"]),
  ),
  op(
    "layout.new",
    "Create a new blank layout.",
    "{ name: string }",
    "local-write",
    objectSchema({ name: requiredStringSchema }, ["name"]),
  ),
  op(
    "layout.rename",
    "Rename a layout.",
    "{ index: number, name: string }",
    "local-write",
    objectSchema({ index: indexSchema, name: requiredStringSchema }, ["index", "name"]),
  ),
  op(
    "layout.duplicate",
    "Duplicate a layout.",
    "{ index: number }",
    "local-write",
    objectSchema({ index: indexSchema }, ["index"]),
  ),
  op(
    "layout.delete",
    "Delete a layout.",
    "{ index: number }",
    "local-write",
    objectSchema({ index: indexSchema }, ["index"]),
    "user-data",
  ),
  op("layout.undo", "Undo last layout change.", "{}", "local-write", objectSchema()),
  op("layout.redo", "Redo last layout change.", "{}", "local-write", objectSchema()),
  op("layout.gridlock", "Tidy all panes into a dense layout.", "{}", "local-write", objectSchema()),
  op(
    "layout.closeFloating",
    "Close all floating panes in the active layout.",
    "{}",
    "local-write",
    objectSchema(),
  ),
  op(
    "layout.placePane",
    "Move a pane to a layout region.",
    "{ paneId: string, region: 'left' | 'right' | 'top' | 'bottom' | 'floating', relativeTo?: string }",
    "local-write",
    objectSchema({
      paneId: requiredStringSchema,
      region: { type: "string", enum: ["left", "right", "top", "bottom", "floating"] },
      relativeTo: stringSchema,
    }, ["paneId", "region"]),
  ),
  op(
    "layout.focusRegion",
    "Focus a pane by visual layout region.",
    "{ region: 'left' | 'right' | 'top' | 'bottom' | 'center' }",
    "local-write",
    objectSchema({
      region: { type: "string", enum: ["left", "right", "top", "bottom", "center"] },
    }, ["region"]),
  ),
  op(
    "layout.setGrid",
    "Dock visible or specified panes into a simple grid.",
    "{ paneIds?: string[], columns?: number }",
    "local-write",
    objectSchema({
      paneIds: { type: "array", items: requiredStringSchema },
      columns: { type: "integer", minimum: 1 },
    }),
  ),
  op("desktop.popOutPane", "Pop a pane into a detached desktop window.", "{ paneId: string }", "local-write", paneIdInput),
  op("desktop.dockPane", "Dock a detached desktop pane.", "{ paneId: string }", "local-write", paneIdInput),
  op(
    "desktop.closeDetachedPane",
    "Close a detached desktop pane.",
    "{ paneId: string }",
    "local-write",
    paneIdInput,
  ),
  op(
    "desktop.focusDetachedPane",
    "Focus a detached desktop pane.",
    "{ paneId: string }",
    "local-write",
    paneIdInput,
  ),
  op(
    "capability.invoke",
    "Invoke a registered plugin capability operation.",
    "{ capabilityId: string, operationId: string, payload?: object }",
    "external-side-effect",
    objectSchema({
      capabilityId: requiredStringSchema,
      operationId: requiredStringSchema,
      payload: openObjectSchema,
    }, ["capabilityId", "operationId"]),
  ),
  op(
    "ui.invoke",
    "Invoke an action on a live semantic UI node.",
    "{ nodeId: string, action?: string, input?: any }",
    "local-write",
    objectSchema({ nodeId: requiredStringSchema, action: stringSchema, input: anySchema }, ["nodeId"]),
  ),
  op(
    "ui.invokeMatching",
    "Invoke an action on the first semantic UI node matching role, label, index, or metadata.",
    "{ role?: string, label?: string, contains?: string, index?: number, action?: string, input?: any, metadata?: object }",
    "local-write",
    objectSchema({
      role: stringSchema,
      label: stringSchema,
      contains: stringSchema,
      index: indexSchema,
      action: stringSchema,
      input: anySchema,
      metadata: openObjectSchema,
    }),
  ),
];

export const REMOTE_AGENT_HELP = {
  title: "Gloomberb remote control guide",
  quickStart: [
    "Read app://snapshot once to orient; it includes schema, current layout, panes, command bar state, and semantic UI nodes.",
    "Prefer app-level operations such as app.search, layout.setGrid, layout.closeFloating, and ticker.pin before falling back to ui.invoke.",
    "Use commandBar.activateResult with label, itemId, or index after app.search; avoid raw node ids unless there is no stable semantic selector.",
    "For list-like surfaces, prefer semantic list activation through commandBar.activateResult or ui.invokeMatching.",
    "Use batch for multi-step flows; steps run sequentially and can return a compact final state so a separate read is not required.",
  ],
  resources: [
    { uri: "app://command-bar", use: "Current command-bar query, open state, selected row, and semantic result rows." },
    { uri: "app://command-bar/results", use: "Just the visible command-bar result/list rows." },
    { uri: "ui://tree", use: "Low-level live semantic controls; use when no app-level operation exists." },
    { uri: "app://panes", use: "Pane instances, placement, focus, and runtime state." },
  ],
  recipes: [
    {
      goal: "Search for a ticker and open the first result",
      requests: [
        { type: "call", operation: "app.search", input: { mode: "ticker", query: "google" } },
        { type: "call", operation: "commandBar.activateResult", input: { index: 0 } },
      ],
      batch: {
        type: "batch",
        include: ["commandBar", "panes"],
        requests: [
          { type: "call", operation: "app.search", input: { mode: "ticker", query: "google" } },
          { type: "call", operation: "commandBar.activateResult", input: { index: 0 } },
        ],
      },
    },
    {
      goal: "Run a command-bar command",
      requests: [
        { type: "call", operation: "app.search", input: { mode: "command", query: "theme" } },
        { type: "call", operation: "commandBar.activateResult", input: { label: "Change Theme" } },
      ],
    },
    {
      goal: "Activate a visible semantic control without knowing its node id",
      request: { type: "call", operation: "ui.invokeMatching", input: { role: "button", label: "Done", action: "press" } },
    },
    {
      goal: "Arrange current panes",
      request: { type: "call", operation: "layout.setGrid", input: { columns: 2 }, include: ["layout", "panes"] },
    },
    {
      goal: "Move a chart cursor without mouse/keyboard control",
      request: { type: "call", operation: "ui.invokeMatching", input: { role: "chart", action: "moveCursor", input: { x: 20, y: 4 } } },
    },
    {
      goal: "Pan a chart through its semantic scroll action",
      request: { type: "call", operation: "ui.invokeMatching", input: { role: "chart", action: "scroll", input: { direction: "down", delta: 3 } } },
    },
  ],
  batching: {
    requestShape: "{ type: 'batch', requests: RemoteControlRequest[], haltOnError?: boolean, settle?: 'none' | 'afterEach' | 'afterBatch', include?: RemoteStateInclude[] }",
    behavior: "Requests run sequentially. By default the batch stops on the first failed step and returns a compact final state.",
  },
  caveats: [
    "Capability manifests are for plugin services; UI control should rely on app-level operations and shared semantic UI nodes so plugins remain remote-agnostic.",
    "If an operation changes UI, request include: ['commandBar'] or use batch include to avoid a follow-up get.",
    "For charts, use visible semantic chart nodes with actions such as moveCursor, press, drag, release, and scroll.",
    "Use ui.invokeMatching only after checking app-level operations; it is intentionally generic and depends on visible semantic controls.",
  ],
};

export function remoteControlSchema(): RemoteControlSchema {
  return {
    protocolVersion: 1,
    resources: REMOTE_RESOURCES,
    operations: REMOTE_OPERATIONS,
    help: REMOTE_AGENT_HELP,
  };
}

export function writeTierForSideEffectLevel(
  sideEffectLevel: RemoteSideEffectLevel,
): RemoteWriteTier {
  switch (sideEffectLevel) {
    case "none":
      return "read";
    case "local-write":
      return "ui-write";
    case "network-write":
      return "user-data";
    case "external-side-effect":
    case "external-trade":
      return "broker";
  }
}

export function remoteOperationDescriptors(): RemoteOperationDescriptor[] {
  return REMOTE_OPERATIONS.map(({ id, title, description, writeTier, inputSchema }) => ({
    name: remoteOperationToolName(id),
    title,
    description,
    writeTier,
    inputSchema,
  }));
}

export function remoteOperationToolName(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function operationTitle(id: string): string {
  const [scope = "", action = ""] = id.split(".");
  return `${humanizeIdentifier(scope)}: ${humanizeIdentifier(action)}`;
}

function humanizeIdentifier(value: string): string {
  if (value === "ui") return "UI";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function op(
  id: string,
  description: string,
  inputShape: string,
  sideEffectLevel: RemoteSideEffectLevel,
  inputSchema: RemoteJsonSchema,
  writeTier = writeTierForSideEffectLevel(sideEffectLevel),
): RemoteOperationSchema {
  return {
    id,
    title: operationTitle(id),
    description,
    inputShape,
    inputSchema,
    sideEffectLevel,
    writeTier,
    requiresConfirmation: writeTier === "user-data" || writeTier === "broker",
    dryRun: sideEffectLevel !== "none",
  };
}
