import type { RemoteControlSchema, RemoteOperationSchema, RemoteResourceSchema } from "./types";

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
  { uri: "app://remote/help", description: "Agent-oriented remote usage guide with efficient recipes and caveats." },
  { uri: "ui://tree", description: "Live semantic UI node tree populated by shared controls and interactive primitives." },
];

export const REMOTE_OPERATIONS: RemoteOperationSchema[] = [
  op("app.openCommandBar", "Open the command bar with an optional query and optional mode.", "{ query?: string, mode?: 'command' | 'ticker' }", "local-write"),
  op("app.closeCommandBar", "Close the command bar.", "{}", "local-write"),
  op("app.setCommandBarQuery", "Set the command bar query.", "{ query: string }", "local-write"),
  op("app.search", "Open command-bar search without requiring UI prefix syntax.", "{ mode: 'command' | 'ticker', query?: string }", "local-write"),
  op("app.switchPanel", "Switch the active panel.", "{ panel: 'left' | 'right' }", "local-write"),
  op("app.notify", "Show an in-app notification.", "{ body: string, type?: string }", "local-write"),
  op("commandBar.activateResult", "Activate a visible command-bar result by zero-based index, node id, item id, or label.", "{ index?: number, nodeId?: string, itemId?: string, label?: string }", "local-write"),
  op("pane.show", "Show or focus a pane type.", "{ paneId: string }", "local-write"),
  op("pane.focus", "Focus a pane instance or pane type.", "{ paneId: string }", "local-write"),
  op("pane.close", "Close a pane instance or pane type.", "{ paneId: string }", "local-write"),
  op("pane.createFromTemplate", "Create a pane from a registered template.", "{ templateId: string, options?: object }", "local-write"),
  op("pane.setState", "Patch pane runtime state.", "{ paneId: string, patch: object }", "local-write"),
  op("pane.setSetting", "Set one pane setting using the pane's registered setting field when available.", "{ paneId: string, key: string, value: any }", "local-write"),
  op("ticker.navigate", "Navigate a ticker into the best available ticker research target.", "{ symbol: string, sourcePaneId?: string }", "local-write"),
  op("ticker.pin", "Open or focus a fixed ticker research pane.", "{ symbol: string, floating?: boolean, forceNewPane?: boolean, paneType?: string }", "local-write"),
  op("ticker.select", "Select a ticker in a target pane.", "{ symbol: string, paneId?: string }", "local-write"),
  op("ticker.switchTab", "Switch ticker research tab.", "{ tabId: string, paneId?: string }", "local-write"),
  op("layout.switch", "Switch active layout by index.", "{ index: number }", "local-write"),
  op("layout.new", "Create a new blank layout.", "{ name: string }", "local-write"),
  op("layout.rename", "Rename a layout.", "{ index: number, name: string }", "local-write"),
  op("layout.duplicate", "Duplicate a layout.", "{ index: number }", "local-write"),
  op("layout.delete", "Delete a layout.", "{ index: number }", "local-write"),
  op("layout.undo", "Undo last layout change.", "{}", "local-write"),
  op("layout.redo", "Redo last layout change.", "{}", "local-write"),
  op("layout.gridlock", "Tidy all panes into a dense layout.", "{}", "local-write"),
  op("layout.closeFloating", "Close all floating panes in the active layout.", "{}", "local-write"),
  op("layout.placePane", "Move a pane to a layout region.", "{ paneId: string, region: 'left' | 'right' | 'top' | 'bottom' | 'floating', relativeTo?: string }", "local-write"),
  op("layout.focusRegion", "Focus a pane by visual layout region.", "{ region: 'left' | 'right' | 'top' | 'bottom' | 'center' }", "local-write"),
  op("layout.setGrid", "Dock visible or specified panes into a simple grid.", "{ paneIds?: string[], columns?: number }", "local-write"),
  op("desktop.popOutPane", "Pop a pane into a detached desktop window.", "{ paneId: string }", "local-write"),
  op("desktop.dockPane", "Dock a detached desktop pane.", "{ paneId: string }", "local-write"),
  op("desktop.closeDetachedPane", "Close a detached desktop pane.", "{ paneId: string }", "local-write"),
  op("desktop.focusDetachedPane", "Focus a detached desktop pane.", "{ paneId: string }", "local-write"),
  op("capability.invoke", "Invoke a registered plugin capability operation.", "{ capabilityId: string, operationId: string, payload?: object }", "local-write"),
  op("ui.invoke", "Invoke an action on a live semantic UI node.", "{ nodeId: string, action?: string, input?: any }", "local-write"),
  op("ui.invokeMatching", "Invoke an action on the first semantic UI node matching role, label, index, or metadata.", "{ role?: string, label?: string, contains?: string, index?: number, action?: string, input?: any, metadata?: object }", "local-write"),
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

function op(
  id: string,
  description: string,
  inputShape: string,
  sideEffectLevel: RemoteOperationSchema["sideEffectLevel"],
): RemoteOperationSchema {
  return { id, description, inputShape, sideEffectLevel, dryRun: sideEffectLevel !== "none" };
}
