import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, findPaneInstance, type LayoutConfig } from "../../../types/config";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { applyPaneSettingFieldValue, createPaneTemplateOrThrow } from "./ops";

function makeDataProvider() {
  return createTestDataProvider({ id: "test" });
}

function makeTickerRepository() {
  return {
    getTicker: async () => null,
    saveTicker: async () => {},
    createTicker: async () => { throw new Error("unused"); },
    deleteTicker: async () => {},
    getAllTickers: async () => [],
  };
}

describe("createPaneTemplateOrThrow", () => {
  test("treats createInstance null as cancellation and does not create a pane", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const buildCalls: unknown[] = [];
    const placeCalls: unknown[] = [];

    await createPaneTemplateOrThrow("cancelled-pane", undefined, {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      pluginRegistry: {
        paneTemplates: new Map([
          ["cancelled-pane", {
            id: "cancelled-pane",
            paneId: "test-pane",
            label: "Cancelled Pane",
            description: "Should cancel cleanly",
            createInstance: async () => null,
          }],
        ]),
        panes: new Map([
          ["test-pane", {
            id: "test-pane",
            name: "Test Pane",
            component: () => null,
            defaultPosition: "right",
          }],
        ]),
        getPaneTemplatePluginId: () => undefined,
        events: { emit: () => {} },
      } as any,
      buildPaneInstance: (...args) => {
        buildCalls.push(args);
        return {
          instanceId: "test-pane:1",
          paneId: "test-pane",
          title: "Broken Pane",
        } as any;
      },
      placePaneInstance: (...args) => {
        placeCalls.push(args);
      },
    });

    expect(buildCalls).toHaveLength(0);
    expect(placeCalls).toHaveLength(0);
  });

  test("passes pane template instance ids through to pane creation", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const buildCalls: unknown[] = [];

    await createPaneTemplateOrThrow("financial-analysis-pane", undefined, {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      pluginRegistry: {
        paneTemplates: new Map([
          ["financial-analysis-pane", {
            id: "financial-analysis-pane",
            paneId: "financial-analysis",
            label: "Financial Analysis",
            description: "Open financial statements",
            createInstance: () => ({
              instanceId: "financial-analysis:AAPL",
              title: "FA AAPL",
              binding: { kind: "fixed", symbol: "AAPL" },
              placement: "floating",
            }),
          }],
        ]),
        panes: new Map([
          ["financial-analysis", {
            id: "financial-analysis",
            name: "Financials",
            component: () => null,
            defaultPosition: "right",
          }],
        ]),
        getPaneTemplatePluginId: () => undefined,
        events: { emit: () => {} },
      } as any,
      buildPaneInstance: (...args) => {
        buildCalls.push(args);
        return {
          instanceId: "financial-analysis:AAPL",
          paneId: "financial-analysis",
          title: "FA AAPL",
        } as any;
      },
      placePaneInstance: () => {},
    });

    expect(buildCalls[0]).toEqual([
      "financial-analysis",
      expect.objectContaining({ instanceId: "financial-analysis:AAPL" }),
    ]);
  });
});

describe("createPaneTemplateOrThrow pane reuse", () => {
  async function runTemplate(
    spec: Record<string, unknown>,
    existing: Array<Record<string, unknown>>,
  ): Promise<{
    focused: string[];
    created: number;
    createdWith: Record<string, unknown> | null;
    layouts: LayoutConfig[];
  }> {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-reuse");
    const layout = cloneLayout(config.layout);
    layout.instances = existing as never;
    const state = createInitialState({ ...config, layout });
    const focused: string[] = [];
    const layouts: LayoutConfig[] = [];
    let created = 0;
    let createdWith: Record<string, unknown> | null = null;

    await createPaneTemplateOrThrow("template", undefined, {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      pluginRegistry: {
        paneTemplates: new Map([
          ["template", {
            id: "template",
            paneId: "chat",
            label: "Chat",
            description: "Chat",
            createInstance: () => spec,
          }],
        ]),
        panes: new Map([["chat", { id: "chat", name: "Chat", component: () => null }]]),
        getPaneTemplatePluginId: () => undefined,
        focusPaneFn: (paneId: string) => focused.push(paneId),
        updateLayoutFn: (next: LayoutConfig) => {
          layouts.push(next);
          state.config.layout = next;
        },
        events: { emit: () => {} },
      } as any,
      buildPaneInstance: (_paneType: string, options?: Record<string, unknown>) => {
        created += 1;
        createdWith = options ?? null;
        return { instanceId: "chat:new", paneId: "chat" } as any;
      },
      placePaneInstance: () => {},
    });

    return { focused, created, createdWith, layouts };
  }

  // The pane rewrites its own channelId as the user switches channels inside it,
  // so reuse has to move it back onto the requested channel before focusing.
  test("retargets the instance a stable id owns when its persisted channel drifted", async () => {
    const result = await runTemplate(
      { instanceId: "chat:general", title: "#general", settings: { channelId: "general" } },
      [{
        instanceId: "chat:general",
        paneId: "chat",
        title: "#random",
        settings: { channelId: "random", fontScale: 2 },
      }],
    );

    expect(result.focused).toEqual(["chat:general"]);
    expect(result.created).toBe(0);
    expect(findPaneInstance(result.layouts[0]!, "chat:general")).toMatchObject({
      title: "#general",
      settings: { channelId: "general", fontScale: 2 },
    });
  });

  test("focuses a matching stable-id pane without rewriting the layout", async () => {
    const result = await runTemplate(
      { instanceId: "chat:general", title: "#general", settings: { channelId: "general" } },
      [{
        instanceId: "chat:general",
        paneId: "chat",
        title: "#general",
        settings: { channelId: "general" },
      }],
    );

    expect(result.focused).toEqual(["chat:general"]);
    expect(result.layouts).toEqual([]);
  });

  test("never focuses another pane type holding the same stable id", async () => {
    const result = await runTemplate(
      { instanceId: "chat:general", settings: { channelId: "general" } },
      [{ instanceId: "chat:general", paneId: "notes", settings: { channelId: "general" } }],
    );

    expect(result.focused).toEqual([]);
    expect(result.created).toBe(1);
    // Reusing the taken id would put two panes on one instance id.
    expect(result.createdWith).toMatchObject({ instanceId: undefined });
  });

  test("keeps a different stable id on its own pane", async () => {
    const result = await runTemplate(
      { instanceId: "chat:trading", settings: { channelId: "trading" } },
      [{ instanceId: "chat:general", paneId: "chat", settings: { channelId: "general" } }],
    );

    expect(result.focused).toEqual([]);
    expect(result.created).toBe(1);
  });

  test("reuses an unkeyed template only on an equivalent spec, ignoring settings key order", async () => {
    const existing = [{
      instanceId: "chat:stored",
      paneId: "chat",
      binding: { kind: "fixed", symbol: "AAPL" },
      settings: { limit: 10, channelId: "general" },
    }];

    const same = await runTemplate(
      { binding: { kind: "fixed", symbol: "AAPL" }, settings: { channelId: "general", limit: 10 } },
      existing,
    );
    expect(same.focused).toEqual(["chat:stored"]);
    expect(same.created).toBe(0);

    const different = await runTemplate(
      { binding: { kind: "fixed", symbol: "MSFT" }, settings: { channelId: "general", limit: 10 } },
      existing,
    );
    expect(different.focused).toEqual([]);
    expect(different.created).toBe(1);
  });
});

describe("applyPaneSettingFieldValue", () => {
  test("lets a pane map derived setting fields back to its canonical settings object", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const layout = cloneLayout(config.layout);
    const pane = findPaneInstance(layout, "portfolio-list:main");
    if (!pane) throw new Error("missing test pane");
    pane.paneId = "nested-settings";
    pane.settings = { canonical: { mode: "line" } };
    const state = createInitialState({ ...config, layout });
    const persisted: LayoutConfig[] = [];
    const applied: unknown[] = [];

    await applyPaneSettingFieldValue(pane.instanceId, {
      key: "mode",
      label: "Mode",
      type: "select",
      options: [],
    }, "area", {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      persistLayout: (nextLayout) => { persisted.push(nextLayout); },
      pluginRegistry: {
        resolvePaneSettings: () => ({
          paneId: pane.instanceId,
          pane,
          paneDef: {
            id: "nested-settings",
            name: "Nested Settings",
            component: () => null,
            defaultPosition: "right",
          },
          rawSettings: pane.settings,
          settingsDef: {
            values: { mode: "line" },
            fields: [],
            applyValue: (settings: Record<string, unknown>, field: unknown, value: unknown) => {
              applied.push([settings, field, value]);
              return { canonical: { mode: value } };
            },
          },
          context: {
            config: state.config,
            layout: state.config.layout,
            paneId: pane.instanceId,
            paneType: "nested-settings",
            pane,
            settings: { ...pane.settings, mode: "line" },
            paneState: {},
            activeTicker: null,
            activeCollectionId: null,
          },
        }),
      } as any,
    });

    expect(applied).toHaveLength(1);
    expect(findPaneInstance(persisted[0]!, pane.instanceId)?.settings).toEqual({
      canonical: { mode: "area" },
    });
  });

  test("atomically clears dependent plugin settings when a selector changes", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    config.pluginConfig.ai = { defaultProviderId: "claude", defaultModelId: "opus" };
    const state = createInitialState(config);
    const updates: unknown[] = [];
    const pane = findPaneInstance(state.config.layout, "chat:main")!;

    await applyPaneSettingFieldValue("chat:main", {
      key: "defaultProviderId",
      label: "Default provider",
      type: "select",
      storage: "plugin",
      clearOnChange: ["defaultModelId"],
      options: [],
    }, "codex", {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      persistLayout: () => {},
      pluginRegistry: {
        resolvePaneSettings: () => ({
          paneId: "chat:main",
          pluginId: "ai",
          pane,
          paneDef: { id: "chat", name: "Chat", component: () => null, defaultPosition: "right" },
          settingsDef: { fields: [] },
          rawSettings: {},
          context: {
            config: state.config,
            layout: state.config.layout,
            paneId: "chat:main",
            paneType: "chat",
            pane,
            settings: config.pluginConfig.ai,
            paneState: {},
            activeTicker: null,
            activeCollectionId: null,
          },
        }),
        setConfigStates: async (pluginId: string, values: Record<string, unknown>) => {
          updates.push({ pluginId, values });
        },
      } as any,
    });

    expect(updates).toEqual([{
      pluginId: "ai",
      values: { defaultModelId: "", defaultProviderId: "codex" },
    }]);
  });

  test("clears a pane model override in the same layout update as its provider", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const pane = findPaneInstance(state.config.layout, "chat:main")!;
    pane.settings = { providerId: "claude", modelId: "opus" };
    const persisted: LayoutConfig[] = [];

    await applyPaneSettingFieldValue("chat:main", {
      key: "providerId",
      label: "Provider",
      type: "select",
      clearOnChange: ["modelId"],
      options: [],
    }, "codex", {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: () => {},
      getState: () => state,
      persistLayout: (layout) => { persisted.push(layout); },
      pluginRegistry: {
        resolvePaneSettings: () => ({
          paneId: "chat:main",
          pane,
          paneDef: { id: "chat", name: "Chat", component: () => null, defaultPosition: "right" },
          settingsDef: { fields: [] },
          rawSettings: pane.settings ?? {},
          context: {
            config: state.config,
            layout: state.config.layout,
            paneId: "chat:main",
            paneType: "chat",
            pane,
            settings: pane.settings ?? {},
            paneState: {},
            activeTicker: null,
            activeCollectionId: null,
          },
        }),
      } as any,
    });

    expect(findPaneInstance(persisted[0]!, "chat:main")?.settings).toMatchObject({
      providerId: "codex",
      modelId: "",
    });
  });

  test("keeps portfolio panes on their displayed collection when switching back to all collections", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const layout = cloneLayout(config.layout);
    const portfolioPane = findPaneInstance(layout, "portfolio-list:main");
    if (!portfolioPane) throw new Error("missing portfolio pane");
    portfolioPane.settings = {
      ...(portfolioPane.settings ?? {}),
      collectionScope: "watchlists",
      visibleCollectionIds: ["watchlist"],
      hideTabs: true,
      lockedCollectionId: "watchlist",
    };

    const state = createInitialState({ ...config, layout });
    state.paneState["portfolio-list:main"] = {
      collectionId: "main",
      cursorSymbol: null,
    };

    const persisted: LayoutConfig[] = [];
    const actions: unknown[] = [];

    await applyPaneSettingFieldValue("portfolio-list:main", {
      key: "collectionScope",
      label: "Collections",
      type: "select",
      options: [],
    }, "all", {
      dataProvider: makeDataProvider() as any,
      tickerRepository: makeTickerRepository() as any,
      dispatch: (action) => { actions.push(action); },
      getState: () => state,
      persistLayout: (nextLayout) => { persisted.push(nextLayout); },
      pluginRegistry: {
        resolvePaneSettings: () => ({
          paneId: "portfolio-list:main",
          pane: portfolioPane,
          paneDef: {
            id: "portfolio-list",
            name: "Portfolio",
            component: () => null,
            defaultPosition: "left",
          },
          settingsDef: { title: "Portfolio Pane Settings", fields: [] },
          context: {
            config: state.config,
            layout: state.config.layout,
            paneId: "portfolio-list:main",
            paneType: "portfolio-list",
            pane: portfolioPane,
            settings: portfolioPane.settings ?? {},
            paneState: state.paneState["portfolio-list:main"] ?? {},
            activeTicker: null,
            activeCollectionId: "main",
          },
        }),
      } as any,
    });

    const nextPane = findPaneInstance(persisted[0]!, "portfolio-list:main");
    expect(nextPane?.settings).toMatchObject({ collectionScope: "all" });
    expect("visibleCollectionIds" in (nextPane?.settings ?? {})).toBe(false);
    expect("hideTabs" in (nextPane?.settings ?? {})).toBe(false);
    expect("lockedCollectionId" in (nextPane?.settings ?? {})).toBe(false);
    expect(nextPane?.params?.collectionId).toBe("watchlist");
    expect(actions).toContainEqual({
      type: "UPDATE_PANE_STATE",
      paneId: "portfolio-list:main",
      patch: { collectionId: "watchlist" },
    });
  });
});
