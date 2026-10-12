import { describe, expect, test } from "bun:test";
import {
  collectDisabledPaneIds,
  resolveShellVisibleLayout,
  restoreShellHiddenPanes,
} from "../../components/layout/shell/visible-layout";
import { applyDrop, findDockLeaf, removePane } from "../../layout/pane-manager";
import { getNodeAtPath } from "../../layout/pane-manager/dock-tree";
import { appReducer, createInitialState } from "../../state/app/context";
import { createTestDataProvider } from "../../test-support/data-provider";
import {
  createDefaultConfig,
  createPaneInstance,
  findPaneInstance,
  type AppConfig,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../../types/config";
import type { PaneDef } from "../../types/plugin";
import { subscribeFormModalRequests, type FormModalRequest } from "../../components/form-modal/request";
import { bindAppPanePluginRegistry } from "./plugin-bindings";

const paneDef: PaneDef = {
  id: "prediction-markets",
  name: "Prediction Markets",
  component: () => null,
  defaultPosition: "left",
  defaultMode: "floating",
};

function bindPortablePaneRuntime(disabledPlugins: string[] = [], options: { isDetachedWindow?: boolean } = {}) {
  const config = createDefaultConfig("/tmp/gloomberb-portable-pane-test");
  config.disabledPlugins = disabledPlugins;
  const state = createInitialState(config);
  const actions: any[] = [];
  const built: PaneInstanceConfig[] = [];
  const placed: Array<{ instance: PaneInstanceConfig; options: unknown }> = [];
  const notes: string[] = [];
  const shown: string[] = [];
  const pluginRegistry = {
    panes: new Map<string, PaneDef>([[paneDef.id, paneDef], ["brokers", { ...paneDef, id: "brokers", name: "Brokers" }]]),
    getDisabledPaneOwner: (_paneId: string, disabled: readonly string[]) => (
      disabled.includes("prediction-markets") ? { id: "prediction-markets", name: "Prediction Markets" } : null
    ),
    getTermSize: () => ({ width: 120, height: 40 }),
    commands: new Map([["set-alert", { id: "set-alert", label: "Add Alert", wizard: [{ key: "symbol", label: "Symbol" }] }]]),
    notify: (notification: { body?: string }) => notes.push(notification.body ?? ""),
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as any;

  bindAppPanePluginRegistry({
    activatePane() {},
    buildPaneInstance: (paneId, options) => {
      const instance = { paneId, ...options } as PaneInstanceConfig;
      built.push(instance);
      return instance;
    },
    createPaneFromTemplate: async () => {},
    dataProvider: createTestDataProvider(),
    detachedPaneId: null,
    dispatch: (action) => actions.push(action),
    focusVisiblePane() {},
    isDetachedWindow: options.isDetachedWindow ?? false,
    openPaneSettings: async () => {},
    openPinnedTicker: async () => {},
    persistLayout() {},
    placePaneInstance: (instance, _def, options) => placed.push({ instance, options }),
    placePinnedTickerTarget() {},
    pluginRegistry,
    publishTickerOpenTarget() {},
    resolveOpenTickerTarget: async () => null,
    resolvePaneTarget: () => null,
    selectTickerInPane() {},
    showPane: (paneId) => { shown.push(paneId); },
    state,
    stateRef: { current: state },
    switchTickerResearchTab() {},
    tickerRepository: {} as any,
  });

  return { actions, built, notes, placed, pluginRegistry, shown };
}

const portablePane = {
  schemaVersion: 2 as const,
  sourceConfigVersion: 13,
  layout: {
    dockRoot: null,
    instances: [{
      instanceId: "p1",
      paneId: "prediction-markets",
      title: "Fed Markets",
      binding: { kind: "none" as const },
      params: { query: "fed" },
      settings: { dense: true },
    }],
    floating: [{ instanceId: "p1", x: 0, y: 0, width: 100, height: 30 }],
    detached: [],
  },
  paneState: {
    p1: { pluginState: { "prediction-markets": { searchQuery: "fed" } } },
  },
};

describe("portable pane runtime", () => {
  test("creates a fresh floating pane and restores its complete state", async () => {
    const runtime = bindPortablePaneRuntime();

    await runtime.pluginRegistry.openPortablePaneShareAsync(portablePane);

    expect(runtime.built).toHaveLength(1);
    expect(runtime.built[0]).toMatchObject({
      paneId: "prediction-markets",
      title: "Fed Markets",
      binding: { kind: "none" },
      params: { query: "fed" },
      settings: { dense: true },
    });
    expect(runtime.built[0]!.instanceId).toMatch(/^prediction-markets:shared-/);
    expect(runtime.placed).toEqual([{
      instance: runtime.built[0],
      options: { placement: "floating" },
    }]);
    expect(runtime.actions).toContainEqual({
      type: "REPLACE_PANE_STATE",
      paneId: runtime.built[0]!.instanceId,
      state: portablePane.paneState.p1,
    });
    expect(runtime.actions.some((action) => action.type === "INSTALL_LAYOUT_COPY")).toBe(false);
  });

  test("rejects panes owned by a disabled plugin", async () => {
    const runtime = bindPortablePaneRuntime(["prediction-markets"]);
    await expect(runtime.pluginRegistry.openPortablePaneShareAsync(portablePane)).rejects.toThrow(
      "Turn on Prediction Markets to open this shared pane.",
    );
    expect(runtime.built).toHaveLength(0);
  });
});

describe("form launches", () => {
  // Menus, panes and the status bar open forms straight in the modal; the
  // bar never mounts to relay them. Add Broker is the Brokers pane's.
  test("open the form modal without the command bar, and Add Broker in the Brokers pane", () => {
    const requests: FormModalRequest[] = [];
    const unsubscribe = subscribeFormModalRequests((request) => {
      requests.push(request);
      return true;
    });
    try {
      const runtime = bindPortablePaneRuntime();
      runtime.pluginRegistry.openBuiltInWorkflow("new-portfolio");
      runtime.pluginRegistry.openPluginCommandWorkflow("set-alert");
      runtime.pluginRegistry.openBuiltInWorkflow("add-broker-account");
      expect(requests).toEqual([
        { kind: "builtin", actionId: "new-portfolio" },
        { kind: "plugin-command", commandId: "set-alert" },
      ]);
      expect(runtime.shown).toEqual(["brokers"]);
      expect(runtime.actions.some((action) => action.type === "SET_COMMAND_BAR")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  // Forms submit through the main window's state, which a detached window lacks.
  test("say where to go from a detached window", () => {
    const requests: FormModalRequest[] = [];
    const unsubscribe = subscribeFormModalRequests((request) => {
      requests.push(request);
      return true;
    });
    try {
      const runtime = bindPortablePaneRuntime([], { isDetachedWindow: true });
      runtime.pluginRegistry.openBuiltInWorkflow("add-broker-account");
      runtime.pluginRegistry.openPluginCommandWorkflow("set-alert");
      expect(requests).toEqual([]);
      expect(runtime.notes).toEqual(["Open this from the main window.", "Open this from the main window."]);
    } finally {
      unsubscribe();
    }
  });
});


const PANES_BY_PLUGIN: Record<string, string[]> = {
  portfolio: ["portfolio-list"],
  "ticker-core": ["ticker-detail"],
  credit: ["cds"],
  "rates-macro": ["econ"],
  earnings: ["earnings-calendar"],
  "global-markets": ["world-venue-map"],
};

/** Docked panes, one stacked under the list, and a floating one, each with saved state. */
function toggleLayout(): LayoutConfig {
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.35,
      first: {
        kind: "split",
        axis: "vertical",
        ratio: 0.6,
        first: { kind: "pane", instanceId: "list" },
        second: { kind: "pane", instanceId: "cds" },
      },
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.45,
        first: { kind: "pane", instanceId: "des" },
        second: { kind: "pane", instanceId: "map" },
      },
    },
    instances: [
      createPaneInstance("portfolio-list", { instanceId: "list" }),
      createPaneInstance("cds", { instanceId: "cds", binding: { kind: "fixed", symbol: "F" } }),
      createPaneInstance("ticker-detail", { instanceId: "des", binding: { kind: "fixed", symbol: "AAPL" } }),
      createPaneInstance("world-venue-map", { instanceId: "map" }),
      createPaneInstance("econ", { instanceId: "eco", params: { country: "JP" } }),
    ],
    floating: [{ instanceId: "eco", x: 50, y: 6, width: 60, height: 20, zIndex: 51 }],
    detached: [],
  };
}

function bindPluginToggleRuntime() {
  const config = createDefaultConfig("/tmp/gloomberb-plugin-toggle-test");
  config.layout = toggleLayout();
  config.layouts = [{ name: "Main", layout: toggleLayout(), focusedPaneId: "cds", paneState: {
    cds: { activeTabId: "curve" },
    eco: { activeTabId: "calendar", pluginState: { "rates-macro": { region: "asia" } } },
    map: { pluginState: { "global-markets": { zoom: 3 } } },
  } }];
  config.activeLayoutIndex = 0;
  const stateRef = { current: createInitialState(config) };
  const actions: any[] = [];
  const saves: AppConfig[] = [];
  const events: string[] = [];
  const pluginRegistry = {
    panes: new Map(Object.values(PANES_BY_PLUGIN).flat().map((id) => [id, { ...paneDef, id }])),
    getPluginPaneIds: (pluginId: string) => PANES_BY_PLUGIN[pluginId] ?? [],
    events: { emit: (name: string) => events.push(name) },
    getTermSize: () => ({ width: 120, height: 40 }),
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as any;
  bindAppPanePluginRegistry({
    activatePane() {},
    buildPaneInstance: () => null,
    createPaneFromTemplate: async () => {},
    dataProvider: createTestDataProvider(),
    detachedPaneId: null,
    dispatch: (action) => {
      actions.push(action);
      stateRef.current = appReducer(stateRef.current, action);
    },
    externalPlugins: [],
    focusVisiblePane() {},
    isDetachedWindow: false,
    openPaneSettings: async () => {},
    openPinnedTicker: async () => {},
    persistConfig: (next) => saves.push(next),
    persistLayout() {},
    placePaneInstance() {},
    placePinnedTickerTarget() {},
    pluginRegistry,
    publishTickerOpenTarget() {},
    resolveOpenTickerTarget: async () => null,
    resolvePaneTarget: () => null,
    selectTickerInPane() {},
    showPane() {},
    state: stateRef.current,
    stateRef,
    switchTickerResearchTab() {},
    tickerRepository: {} as any,
  });
  /** An edit made by the shell on what it shows, saved the way the shell saves it. */
  const editShownLayout = (edit: (shown: LayoutConfig) => LayoutConfig) => {
    const { config: current } = stateRef.current;
    const disabledPaneIds = collectDisabledPaneIds(pluginRegistry, current.disabledPlugins);
    const shown = resolveShellVisibleLayout(current.layout, disabledPaneIds, pluginRegistry.panes);
    const layout = restoreShellHiddenPanes(current.layout, edit(shown), disabledPaneIds, pluginRegistry.panes);
    stateRef.current = appReducer(stateRef.current, { type: "UPDATE_LAYOUT", layout });
  };
  return { actions, editShownLayout, events, pluginRegistry, saves, stateRef };
}

describe("switching plugins", () => {
  test("switches two plugins in one change, leaves the layout alone, and moves focus off a pane that went hidden", () => {
    const runtime = bindPluginToggleRuntime();
    const before = runtime.stateRef.current;

    runtime.pluginRegistry.setPluginsEnabled({ credit: false, "rates-macro": false });

    expect(runtime.actions).toEqual([{
      type: "SET_DISABLED_PLUGINS",
      disabledPlugins: [...before.config.disabledPlugins, "credit", "rates-macro"],
      focusedPaneId: "list",
    }]);
    expect(runtime.saves).toHaveLength(1);
    expect(runtime.events).toEqual(["config:changed"]);
    expect(runtime.stateRef.current.config.layout).toEqual(before.config.layout);
    expect(runtime.stateRef.current.paneState).toEqual(before.paneState);

    // Setting, not flipping: a repeat is a no-op, and the retired group id switches all of Macro.
    runtime.pluginRegistry.setPluginsEnabled({ credit: false });
    expect(runtime.actions).toHaveLength(1);
    runtime.pluginRegistry.setPluginEnabled("macro", true);
    expect(runtime.stateRef.current.config.disabledPlugins).toEqual(before.config.disabledPlugins);
  });

  test("off, other panes closed and moved, then on: hidden panes come back where they were with their state", () => {
    const runtime = bindPluginToggleRuntime();
    const before = runtime.stateRef.current;

    runtime.pluginRegistry.setPluginsEnabled({ credit: false, "rates-macro": false });
    runtime.editShownLayout((shown) => removePane(shown, "des"));
    runtime.editShownLayout((shown) => applyDrop(shown, "map", { kind: "frame", edge: "left" }));
    runtime.pluginRegistry.setPluginsEnabled({ credit: true, "rates-macro": true });

    const after = runtime.stateRef.current;
    for (const instanceId of ["cds", "eco"]) {
      expect(findPaneInstance(after.config.layout, instanceId)).toEqual(findPaneInstance(before.config.layout, instanceId));
      expect(after.paneState[instanceId]).toEqual(before.paneState[instanceId]!);
    }
    expect(after.config.layout.floating).toContainEqual(before.config.layout.floating[0]!);
    // Still stacked under the list, at the same share.
    const stack = getNodeAtPath(after.config.layout.dockRoot, findDockLeaf(after.config.layout, "cds")!.path.slice(0, -1));
    expect(stack).toMatchObject({ axis: "vertical", ratio: 0.6, first: { instanceId: "list" }, second: { instanceId: "cds" } });
    expect(after.config.layout.instances.filter((instance) => instance.paneId === "cds")).toHaveLength(1);
  });
});
