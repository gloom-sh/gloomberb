import { afterEach, describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { createDefaultConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { GloomPlugin, GloomPluginContext } from "../../types/plugin";
import { assetDataProvider } from "../../capabilities";
import {
  applicationPlugin,
  macroPlugin,
  portfolioPlugin,
} from "../builtin/composite-plugins";
import { PluginRegistry } from "./index";

const dataProvider: DataProvider = {
  id: "test-provider",
  name: "Test Provider",
  getTickerFinancials: async () => ({ annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
  getQuote: async (symbol) => ({
    symbol,
    price: 1,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.now(),
  }),
  getExchangeRate: async () => 1,
  search: async () => [],
  getArticleSummary: async () => null,
  getPriceHistory: async () => [],
};

let currentRegistry: PluginRegistry | null = null;
let currentPersistence: AppPersistence | null = null;

function createRegistry(options: {
  disabledPlugins?: string[];
  disabledSources?: string[];
  enableCapabilityHandlers?: boolean;
} = {}): PluginRegistry {
  const persistence = new AppPersistence(":memory:");
  const registry = new PluginRegistry(
    dataProvider,
    new TickerRepository(persistence.tickers),
    persistence,
    { enableCapabilityHandlers: options.enableCapabilityHandlers },
  );
  registry.getConfigFn = () => ({
    ...createDefaultConfig("/tmp/gloomberb-context-menu-test"),
    disabledPlugins: options.disabledPlugins ?? [],
    disabledSources: options.disabledSources ?? [],
  });
  currentRegistry = registry;
  currentPersistence = persistence;
  return registry;
}

function plugin(id: string, setup: (ctx: GloomPluginContext) => void): GloomPlugin {
  return {
    id,
    name: id,
    version: "1.0.0",
    setup,
  };
}

function contextMenuLabels(items: ReturnType<PluginRegistry["getContextMenuItems"]>): string[] {
  return items.flatMap((item) => item.type === "divider" || !item.label ? [] : [item.label]);
}

afterEach(() => {
  currentRegistry?.destroy();
  currentRegistry = null;
  currentPersistence?.close();
  currentPersistence = null;
});

describe("PluginRegistry lifecycle", () => {
  test("rejects retired built-in module ids", async () => {
    const registry = createRegistry();

    await expect(registry.register({
      id: "analytics",
      name: "Conflicting Analytics",
      version: "1.0.0",
    })).rejects.toThrow("Plugin id is reserved by a built-in module: analytics");

    expect(registry.allPlugins.has("analytics")).toBe(false);
  });

  test("rolls back rejected registrations and always removes owned contributions", async () => {
    const registry = createRegistry();
    const pane = {
      id: "shared-pane",
      name: "Shared",
      component: () => null,
      defaultPosition: "right" as const,
    };

    await expect(registry.register({
      id: "setup-failure",
      name: "Setup failure",
      version: "1.0.0",
      panes: [pane],
      setup: () => { throw new Error("setup failed"); },
    })).rejects.toThrow("setup failed");
    expect(registry.allPlugins.has("setup-failure")).toBe(false);
    expect(registry.panes.has("shared-pane")).toBe(false);

    await registry.register({ id: "owner", name: "Owner", version: "1.0.0", panes: [pane] });
    await expect(registry.register({ id: "collision", name: "Collision", version: "1.0.0", panes: [pane] }))
      .rejects.toThrow("Duplicate plugin contribution id");
    expect(registry.panes.get("shared-pane")?.name).toBe("Shared");

    await registry.register({
      id: "throwing-dispose",
      name: "Throwing dispose",
      version: "1.0.0",
      panes: [{
        id: "disposable-pane",
        name: "Disposable",
        component: () => null,
        defaultPosition: "right",
      }],
      dispose: () => { throw new Error("dispose failed"); },
    });
    expect(() => registry.unregister("throwing-dispose")).toThrow("dispose failed");
    expect(registry.allPlugins.has("throwing-dispose")).toBe(false);
    expect(registry.panes.has("disposable-pane")).toBe(false);
  });
});

describe("built-in composite plugin ownership", () => {
  test("registers modules through their one top-level owner", async () => {
    const registry = createRegistry();
    await registry.register(portfolioPlugin);
    await registry.register(applicationPlugin);
    await registry.register(macroPlugin);

    expect(registry.getPluginPaneIds("portfolio")).toEqual(expect.arrayContaining([
      "portfolio-list",
      "analytics",
      "kelly-sizer",
    ]));
    expect(registry.getPluginPaneIds("application")).toEqual(expect.arrayContaining([
      "help",
      "changelog",
    ]));
    expect(registry.getPluginPaneIds("macro")).toEqual(expect.arrayContaining([
      "econ-calendar",
      "yield-curve",
      "earnings-calendar",
      "macro-tv",
    ]));
    expect(registry.getPaneTemplatePluginId("macro-tv-pane")).toBe("macro");
    expect(registry.getPanePluginId("analytics")).toBe("portfolio");
    expect(registry.getPanePluginId("help")).toBe("application");
    expect(registry.getPanePluginId("macro-tv")).toBe("macro");
    expect(registry.getCommandPluginId("earnings-monitor-shortcut")).toBe("macro");
    expect(registry.getCommandPluginId("gridlock-all")).toBe("application");
    expect(registry.allPlugins.has("analytics")).toBe(false);
    expect(registry.allPlugins.has("kelly-sizer")).toBe(false);
    expect(registry.allPlugins.has("changelog")).toBe(false);
  });
});

describe("PluginRegistry context menu providers", () => {
  test("registers and unregisters context menu providers", async () => {
    const registry = createRegistry();
    await registry.register(plugin("tools", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "app-menu",
        contexts: ["app"],
        getItems: () => [{ id: "tools:item", label: "Tools Item" }],
      });
    }));

    expect(contextMenuLabels(registry.getContextMenuItems({ kind: "app" }))).toEqual(["Tools Item"]);

    registry.unregister("tools");
    expect(registry.getContextMenuItems({ kind: "app" })).toEqual([]);
  });

  test("orders providers by order, plugin id, and provider id", async () => {
    const registry = createRegistry();
    await registry.register(plugin("z-plugin", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "z-provider",
        order: 20,
        getItems: () => [{ id: "z", label: "Z" }],
      });
    }));
    await registry.register(plugin("a-plugin", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "b-provider",
        order: 10,
        getItems: () => [{ id: "a-b", label: "A/B" }],
      });
      ctx.registerContextMenuProvider({
        id: "a-provider",
        order: 10,
        getItems: () => [{ id: "a-a", label: "A/A" }],
      });
    }));

    expect(contextMenuLabels(registry.getContextMenuItems({ kind: "app" }))).toEqual([
      "A/A",
      "A/B",
      "Z",
    ]);
  });

  test("filters providers from disabled plugins", async () => {
    const registry = createRegistry({ disabledPlugins: ["disabled-tools"] });
    await registry.register(plugin("disabled-tools", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "hidden",
        getItems: () => [{ id: "hidden", label: "Hidden" }],
      });
    }));
    await registry.register(plugin("enabled-tools", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "visible",
        getItems: () => [{ id: "visible", label: "Visible" }],
      });
    }));

    expect(contextMenuLabels(registry.getContextMenuItems({ kind: "app" }))).toEqual(["Visible"]);
  });

  test("provider exceptions do not prevent other provider items", async () => {
    const registry = createRegistry();
    await registry.register(plugin("bad-tools", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "throws",
        getItems: () => {
          throw new Error("boom");
        },
      });
    }));
    await registry.register(plugin("good-tools", (ctx) => {
      ctx.registerContextMenuProvider({
        id: "works",
        getItems: () => [{ id: "works", label: "Works" }],
      });
    }));

    expect(contextMenuLabels(registry.getContextMenuItems({ kind: "app" }))).toEqual(["Works"]);
  });
});

describe("PluginRegistry capabilities", () => {
  const source = (id: string) => assetDataProvider({ ...dataProvider, id, name: id });

  test("disabled plugins disable their contributed capabilities", async () => {
    const registry = createRegistry({ disabledPlugins: ["source-plugin"] });
    await registry.register({
      id: "source-plugin",
      name: "Source Plugin",
      version: "1.0.0",
      capabilities: [source("source-a")],
    });

    expect(registry.getCapability("asset-data.source-a")?.sourceId).toBe("source-a");
    expect(registry.getCapabilityPluginId("asset-data.source-a")).toBe("source-plugin");
    expect(registry.getEnabledCapabilities("asset-data")).toEqual([]);
  });

  test("disabledSources disables only the matching capability source", async () => {
    const registry = createRegistry({ disabledSources: ["source-a"] });
    await registry.register({
      id: "source-plugin",
      name: "Source Plugin",
      version: "1.0.0",
      capabilities: [source("source-a"), source("source-b")],
    });

    expect(registry.getEnabledCapabilities("asset-data").map((entry) => entry.sourceId)).toEqual(["source-b"]);
  });

  test("can skip plugin capability handlers in renderer registries", async () => {
    const registry = createRegistry({ enableCapabilityHandlers: false });
    await registry.register({
      id: "source-plugin",
      name: "Source Plugin",
      version: "1.0.0",
      capabilities: [source("source-a")],
      setup(ctx) {
        ctx.registerCapability(source("source-b"));
      },
    });

    expect(registry.getCapability("asset-data.source-a")).toBeNull();
    expect(registry.getCapability("asset-data.source-b")).toBeNull();
    expect(registry.getEnabledCapabilities("asset-data")).toEqual([]);
  });
});

describe("PluginRegistry ticker research tabs", () => {
  test("tracks the owning plugin for registered ticker research tabs", async () => {
    const registry = createRegistry();
    await registry.register(plugin("ticker-research", (ctx) => {
      ctx.registerTickerResearchTab({
        id: "sec",
        name: "SEC",
        order: 45,
        component: () => null,
      });
    }));

    expect(registry.getTickerResearchTabPluginId("sec")).toBe("ticker-research");

    registry.unregister("ticker-research");
    expect(registry.getTickerResearchTabPluginId("sec")).toBeUndefined();
  });
});

describe("PluginRegistry pane settings", () => {
  test("resolves effective pane setting values from settings definitions", async () => {
    const registry = createRegistry();
    const config = createDefaultConfig("/tmp/gloomberb-pane-settings-test");
    config.layout = {
      dockRoot: { kind: "pane", instanceId: "test-pane:main" },
      instances: [{
        instanceId: "test-pane:main",
        paneId: "test-pane",
        binding: { kind: "none" },
        settings: {},
      }],
      floating: [],
      detached: [],
    };
    registry.getConfigFn = () => config;
    registry.getLayoutFn = () => config.layout;

    await registry.register(plugin("tables", (ctx) => {
      ctx.registerPane({
        id: "test-pane",
        name: "Test Pane",
        defaultPosition: "right",
        component: () => null,
        settings: {
          values: {
            columnIds: ["ticker", "price"],
            collectionScope: "all",
          },
          fields: [
            {
              key: "columnIds",
              label: "Columns",
              type: "ordered-multi-select",
              options: [
                { value: "ticker", label: "Ticker" },
                { value: "price", label: "Price" },
              ],
            },
            {
              key: "collectionScope",
              label: "Collections",
              type: "select",
              options: [{ value: "all", label: "All" }],
            },
          ],
        },
      });
    }));

    const descriptor = registry.resolvePaneSettings("test-pane:main");

    expect(descriptor?.context.settings.columnIds).toEqual(["ticker", "price"]);
    expect(descriptor?.context.settings.collectionScope).toBe("all");
    expect(descriptor?.rawSettings.columnIds).toBeUndefined();
  });

  test("resolves plugin-scoped pane setting values from plugin config", async () => {
    const registry = createRegistry();
    const config = createDefaultConfig("/tmp/gloomberb-pane-settings-test");
    config.layout = {
      dockRoot: { kind: "pane", instanceId: "test-pane:main" },
      instances: [{
        instanceId: "test-pane:main",
        paneId: "test-pane",
        binding: { kind: "none" },
        settings: { breakingNewsNotificationsEnabled: false },
      }],
      floating: [],
      detached: [],
    };
    config.pluginConfig = {
      news: { breakingNewsNotificationsEnabled: true },
    };
    registry.getConfigFn = () => config;
    registry.getLayoutFn = () => config.layout;

    await registry.register(plugin("news", (ctx) => {
      ctx.registerPane({
        id: "test-pane",
        name: "Test Pane",
        defaultPosition: "right",
        component: () => null,
        settings: {
          fields: [{
            key: "breakingNewsNotificationsEnabled",
            label: "Notifications",
            type: "toggle",
            storage: "plugin",
          }],
        },
      });
    }));

    const descriptor = registry.resolvePaneSettings("test-pane:main");

    expect(descriptor?.pluginId).toBe("news");
    expect(descriptor?.context.settings.breakingNewsNotificationsEnabled).toBe(true);
  });

  test("resolves and applies toggle-backed pane quick settings", async () => {
    const registry = createRegistry();
    const config = createDefaultConfig("/tmp/gloomberb-pane-quick-settings-test");
    config.layout = {
      dockRoot: { kind: "pane", instanceId: "test-pane:main" },
      instances: [{
        instanceId: "test-pane:main",
        paneId: "test-pane",
        binding: { kind: "none" },
        settings: {},
      }],
      floating: [],
      detached: [],
    };
    registry.getConfigFn = () => config;
    registry.getLayoutFn = () => config.layout;

    await registry.register(plugin("quotes", (ctx) => {
      ctx.registerPane({
        id: "test-pane",
        name: "Test Pane",
        defaultPosition: "right",
        component: () => null,
        quickSettings: [{ type: "toggle", key: "liveStreaming", icon: "zap" }],
        settings: {
          values: { liveStreaming: true },
          fields: [{
            key: "liveStreaming",
            label: "Live streaming",
            type: "toggle",
          }],
        },
      });
    }));

    const applied: Array<{ key: string; value: unknown }> = [];
    registry.applyPaneSettingValueFn = async (_paneId, field, value) => {
      applied.push({ key: field.key, value });
    };

    expect(registry.resolvePaneQuickSettings("test-pane:main")).toMatchObject([{
      key: "liveStreaming",
      icon: "zap",
      label: "Live streaming",
      value: true,
    }]);

    await registry.togglePaneQuickSetting("test-pane:main", "liveStreaming");
    expect(applied).toEqual([{ key: "liveStreaming", value: false }]);
  });
});

describe("PluginRegistry broker runtime", () => {
  test("exposes broker adapters and broker instance operations to rendered panes", async () => {
    const registry = createRegistry();
    const broker = {
      id: "demo",
      name: "Demo",
      configSchema: [],
      validate: async () => true,
      importPositions: async () => [],
    };
    const calls: string[] = [];
    registry.connectBrokerInstanceFn = async (instanceId) => { calls.push(`connect:${instanceId}`); };
    registry.updateBrokerInstanceFn = async (instanceId, values, options) => {
      calls.push(`update:${instanceId}:${values.mode}:${options?.replaceConfig ? "replace" : "merge"}`);
    };
    registry.syncBrokerInstanceFn = async (instanceId) => { calls.push(`sync:${instanceId}`); };
    registry.removeBrokerInstanceFn = async (instanceId) => { calls.push(`remove:${instanceId}`); };

    await registry.register({
      id: "demo-plugin",
      name: "Demo Plugin",
      version: "1.0.0",
      broker,
    });

    expect(registry.getBrokerAdapter("demo")).toBe(broker);
    await registry.connectBrokerInstance("demo-live");
    await registry.updateBrokerInstance("demo-live", { mode: "paper" }, { replaceConfig: true });
    await registry.syncBrokerInstance("demo-live");
    await registry.removeBrokerInstance("demo-live");

    expect(calls).toEqual([
      "connect:demo-live",
      "update:demo-live:paper:replace",
      "sync:demo-live",
      "remove:demo-live",
    ]);
  });
});
