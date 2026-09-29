import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../state/app/context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig, type PaneInstanceConfig } from "../../types/config";
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
    showPane: (paneId: string) => shown.push(paneId),
    getPanePluginId: () => "prediction-markets",
    getTermSizeFn: () => ({ width: 120, height: 40 }),
    commands: new Map([["set-alert", { id: "set-alert", label: "Add Alert", wizard: [{ key: "symbol", label: "Symbol" }] }]]),
    notify: (notification: { body?: string }) => notes.push(notification.body ?? ""),
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
    showPane() {},
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

    await runtime.pluginRegistry.openPortablePaneShareAsyncFn(portablePane);

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
    await expect(runtime.pluginRegistry.openPortablePaneShareAsyncFn(portablePane)).rejects.toThrow(
      "unavailable",
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
      runtime.pluginRegistry.openBuiltInWorkflowFn("new-portfolio");
      runtime.pluginRegistry.openPluginCommandWorkflowFn("set-alert");
      runtime.pluginRegistry.openBuiltInWorkflowFn("add-broker-account");
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
      runtime.pluginRegistry.openBuiltInWorkflowFn("add-broker-account");
      runtime.pluginRegistry.openPluginCommandWorkflowFn("set-alert");
      expect(requests).toEqual([]);
      expect(runtime.notes).toEqual(["Open this from the main window.", "Open this from the main window."]);
    } finally {
      unsubscribe();
    }
  });
});

