import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, findPaneInstance, type LayoutConfig } from "../../../types/config";
import { createInitialState, type AppState } from "../../../state/app/context";
import { PANE_LOCK_SETTING_KEY } from "../../../pane-settings";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { applyPaneSettingFieldValue, createPaneTemplateOrThrow, resolveTickerInput, resolveTickerInputOrThrow, resolveTickerListInput } from "./ops";
import type { TickerRecord } from "../../../types/ticker";
import { bringToFront } from "../../../layout/pane-manager/floating-actions";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { createTestTicker } from "../../../test-support/ticker";
import { AppPersistence } from "../../../data/app-persistence";
import { TickerRepository } from "../../../data/ticker-repository";
import { PluginRegistry } from "../../../plugins/registry";
import { PluginOffError } from "../../../plugins/plugin-off";

type TemplateDeps = Parameters<typeof createPaneTemplateOrThrow>[2];

/** The deps every workflow op takes, with just the registry members a test needs. */
function workflowDeps(state: AppState, registry: Record<string, unknown>) {
  return {
    dataProvider: createTestDataProvider({ id: "test" }),
    tickerRepository: new JsonTickerRepository(),
    dispatch: () => {},
    getState: () => state,
    pluginRegistry: registry as unknown as PluginRegistry,
  };
}

/** Deps for opening `template`, whose pane type is `pane`. */
function templateDeps(
  state: AppState,
  { template, pane, registry, ...deps }: {
    template: { id: string } & Record<string, unknown>;
    pane: { id: string } & Record<string, unknown>;
    registry?: Record<string, unknown>;
  } & Pick<TemplateDeps, "buildPaneInstance"> & Partial<TemplateDeps>,
): TemplateDeps {
  return {
    ...workflowDeps(state, {
      paneTemplates: new Map([[template.id, template]]),
      panes: new Map([[pane.id, pane]]),
      getPaneTemplatePluginId: () => undefined,
      getDisabledPaneTemplateOwner: () => null,
      events: { emit: () => {} },
      ...registry,
    }),
    placePaneInstance: () => {},
    ...deps,
  };
}

test("qualified command inputs persist each selected venue without copying existing holdings", async () => {
  for (const savedVenue of [null, "NASDAQ", "AMS"]) {
    const tickerRepository = new JsonTickerRepository();
    const state = createInitialState(createDefaultConfig(":memory:"));
    if (savedVenue) {
      const saved = await tickerRepository.createTicker(createTestTicker("ASML", "ASML Holding", {
        exchange: savedVenue,
        currency: savedVenue === "NASDAQ" ? "USD" : "EUR",
        portfolios: ["retirement"],
        positions: [{ portfolio: "retirement", shares: 10, avgCost: 500, broker: "manual", currency: savedVenue === "NASDAQ" ? "USD" : "EUR" }],
      }).metadata);
      state.tickers.set("ASML", saved);
    }
    const before = await tickerRepository.loadTicker("ASML");
    const deps = {
      getState: () => state,
      dispatch: (action: any) => { if (action.type === "UPDATE_TICKER") state.tickers.set(action.ticker.metadata.ticker, action.ticker); },
      pluginRegistry: { events: { emit: () => {} } } as any,
      tickerRepository,
      dataProvider: createTestDataProvider({ search: async () => ["NASDAQ", "AMS"].map(exchange => ({
        providerId: "cloud", symbol: "ASML", name: "ASML Holding", exchange,
        currency: exchange === "NASDAQ" ? "USD" : "EUR", type: "EQUITY",
      })) }),
    };
    expect(await resolveTickerListInput("ASML:XNAS ASML:XAMS ASML:NASDAQ", null, deps))
      .toEqual(["ASML:XNAS", "ASML:XAMS"]);
    const selected = await resolveTickerInput("ASML:XNAS", null, null, deps, { preserveListingKey: true });
    expect(selected?.symbol).toBe("ASML:XNAS");
    expect(selected?.ticker.metadata).toMatchObject({ ticker: "ASML:XNAS", currency: "USD", positions: [], portfolios: [] });
    expect((await tickerRepository.loadTicker("ASML:XAMS"))?.metadata)
      .toMatchObject({ ticker: "ASML:XAMS", currency: "EUR", positions: [], portfolios: [] });
    expect(await tickerRepository.loadTicker("ASML")).toEqual(before);
  }
});

test("command ticker resolution persists the verified future without switching to a saved equity", async () => {
  const state = createInitialState(createDefaultConfig(":memory:"));
  const equity: TickerRecord = createTestTicker("ESF", "Eurotech", { exchange: "MTA", currency: "EUR", portfolios: ["long-term"] });
  state.tickers.set("ESF", equity);
  const original = structuredClone(equity);
  const created: TickerRecord[] = [];
  const resolved = await resolveTickerInput(" es=f ", "ESF", null, {
    getState: () => state,
    dispatch: () => {},
    pluginRegistry: { events: { emit: () => {} } } as any,
    tickerRepository: {
      loadTicker: async (symbol: string) => state.tickers.get(symbol) ?? null,
      createTicker: async (metadata: TickerRecord["metadata"]) => {
        const ticker = { metadata };
        created.push(ticker);
        return ticker;
      },
    } as any,
    dataProvider: createTestDataProvider({
      search: async () => [{ providerId: "test", symbol: "ESF", name: "Eurotech", exchange: "MTA", type: "EQUITY" }],
      getQuote: async (symbol) => ({
        symbol, name: "S&P 500 Futures", exchangeName: "CME", currency: "USD",
        price: 6000, lastUpdated: Date.now(), change: 0, changePercent: 0,
      }),
    }),
  });
  expect(resolved).toMatchObject({ symbol: "ES=F", source: "provider", created: true });
  expect(created[0]?.metadata).toMatchObject({ ticker: "ES=F", assetCategory: "FUTURE", currency: "USD", exchange: "CME" });
  expect(equity).toEqual(original);
});

describe("createPaneTemplateOrThrow", () => {
  // CHOKE belongs to one plugin and opens a chart, a pane of another: with
  // that one off, the chart would be added and then hidden.
  test("refuses a template whose pane belongs to a switched-off plugin, naming it", async () => {
    const persistence = new AppPersistence(":memory:");
    const registry = new PluginRegistry(createTestDataProvider(), new TickerRepository(persistence.tickers), persistence);
    try {
      const state = createInitialState({ ...createDefaultConfig(":memory:"), disabledPlugins: ["charts"] });
      registry.bindHost({ getConfig: () => state.config });
      await registry.register({
        id: "maps", name: "Maps", version: "1.0.0",
        paneTemplates: [{ id: "choke", paneId: "chart", label: "Chokepoints", description: "Chokepoints" }],
      });
      await registry.register({
        id: "charts", name: "Charts", version: "1.0.0",
        panes: [{ id: "chart", name: "Chart", component: () => null, defaultPosition: "right" }],
      });
      const built: string[] = [];
      const opening = createPaneTemplateOrThrow("choke", undefined, {
        ...workflowDeps(state, {}),
        pluginRegistry: registry,
        buildPaneInstance: (paneId) => { built.push(paneId); return null; },
        placePaneInstance: () => {},
      });
      await expect(opening).rejects.toBeInstanceOf(PluginOffError);
      await expect(opening).rejects.toMatchObject({ plugin: { id: "charts" }, message: "Turn on Charts to open Chokepoints." });
      expect(built).toEqual([]);
    } finally {
      registry.destroy();
      persistence.close();
    }
  });

  test("treats createInstance null as cancellation and does not create a pane", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const buildCalls: unknown[] = [];
    const placeCalls: unknown[] = [];

    await createPaneTemplateOrThrow("cancelled-pane", undefined, templateDeps(state, {
      template: {
        id: "cancelled-pane",
        paneId: "test-pane",
        label: "Cancelled Pane",
        description: "Should cancel cleanly",
        createInstance: async () => null,
      },
      pane: { id: "test-pane", name: "Test Pane", component: () => null, defaultPosition: "right" },
      buildPaneInstance: (...args) => {
        buildCalls.push(args);
        return { instanceId: "test-pane:1", paneId: "test-pane", title: "Broken Pane" };
      },
      placePaneInstance: (...args) => {
        placeCalls.push(args);
      },
    }));

    expect(buildCalls).toHaveLength(0);
    expect(placeCalls).toHaveLength(0);
  });

  test("uses an explicit shared symbol instead of the recipient's active ticker", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const msft: TickerRecord = createTestTicker("MSFT", "Microsoft", { broker_contracts: [] });
    state.tickers.set("MSFT", msft);
    let createdSymbol: string | null | undefined;

    await createPaneTemplateOrThrow("ticker-pane", { symbol: "MSFT" }, templateDeps(state, {
      template: {
        id: "ticker-pane",
        paneId: "ticker-view",
        label: "Ticker View",
        description: "Ticker View",
        shortcut: { prefix: "TV", argPlaceholder: "ticker", argKind: "ticker" },
        createInstance: (_context: unknown, options: { symbol?: string } | undefined) => {
          createdSymbol = options?.symbol;
          return { binding: { kind: "fixed", symbol: options?.symbol ?? "" } };
        },
      },
      pane: { id: "ticker-view", name: "Ticker View", component: () => null, defaultPosition: "right" },
      buildPaneInstance: () => ({ instanceId: "ticker-view:1", paneId: "ticker-view" }),
    }));

    expect(createdSymbol).toBe("MSFT");
  });

  // JOBS, CALLS and CDS open market-wide when nothing was named, so an empty
  // arg must neither fail to resolve nor quietly inherit the focused ticker.
  test("opens an optional-ticker template unbound, ignoring the focused ticker", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const layout = cloneLayout(config.layout);
    layout.instances = [{
      instanceId: "quote-monitor:1",
      paneId: "quote-monitor",
      binding: { kind: "fixed", symbol: "TSLA" },
    }] as never;
    const state = createInitialState({ ...config, layout });
    state.focusedPaneId = "quote-monitor:1";
    const tsla: TickerRecord = createTestTicker("TSLA", "Tesla", { broker_contracts: [] });
    state.tickers.set("TSLA", tsla);
    let createdOptions: { symbol?: string } | undefined | null = null;
    let createdBinding: unknown = "unset";

    await createPaneTemplateOrThrow("jobs-pane", undefined, templateDeps(state, {
      template: {
        id: "jobs-pane",
        paneId: "jobs",
        label: "Hiring",
        description: "Hiring",
        shortcut: { prefix: "JOBS", argPlaceholder: "ticker", argKind: "ticker", argOptional: true },
        createInstance: (_context: unknown, options: { symbol?: string } | undefined) => {
          createdOptions = options;
          return { instanceId: "jobs:home", title: "Hiring", placement: "floating" };
        },
      },
      pane: { id: "jobs", name: "Hiring", component: () => null, defaultPosition: "right" },
      buildPaneInstance: (_paneType: string, options?: { binding?: unknown }) => {
        createdBinding = options?.binding;
        return { instanceId: "jobs:home", paneId: "jobs" };
      },
    }));

    expect(createdOptions?.symbol).toBeUndefined();
    expect(createdBinding).toBeUndefined();
  });

  test("passes pane template instance ids through to pane creation", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const state = createInitialState(config);
    const buildCalls: unknown[] = [];

    await createPaneTemplateOrThrow("financial-analysis-pane", undefined, templateDeps(state, {
      template: {
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
      },
      pane: { id: "financial-analysis", name: "Financials", component: () => null, defaultPosition: "right" },
      buildPaneInstance: (...args) => {
        buildCalls.push(args);
        return { instanceId: "financial-analysis:AAPL", paneId: "financial-analysis", title: "FA AAPL" };
      },
    }));

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
    batchedFloating = false,
  ): Promise<{
    focused: string[];
    created: number;
    createdWith: Record<string, unknown> | null;
    layouts: LayoutConfig[];
  }> {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-reuse");
    const layout = cloneLayout(config.layout);
    layout.instances = existing as never;
    if (batchedFloating) layout.floating = existing.map((instance, index) => ({
      instanceId: instance.instanceId as string, x: 0, y: 0, width: 80, height: 24, zIndex: index,
    }));
    const state = createInitialState({ ...config, layout });
    const focused: string[] = [];
    const layouts: LayoutConfig[] = [];
    let created = 0;
    let createdWith: Record<string, unknown> | null = null;

    await createPaneTemplateOrThrow("template", undefined, templateDeps(state, {
      template: { id: "template", paneId: "chat", label: "Chat", description: "Chat", createInstance: () => spec },
      pane: { id: "chat", name: "Chat", component: () => null },
      registry: {
        focusPane: (paneId: string, nextLayout?: LayoutConfig) => {
          focused.push(paneId);
          if (batchedFloating) layouts.push(bringToFront(nextLayout ?? state.config.layout, paneId));
        },
        updateLayout: (next: LayoutConfig) => {
          layouts.push(next);
          if (!batchedFloating) state.config.layout = next;
        },
      },
      buildPaneInstance: (_paneType: string, options?: Record<string, unknown>) => {
        created += 1;
        createdWith = options ?? null;
        return { instanceId: "chat:new", paneId: "chat" };
      },
    }));

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

  test("batched focus keeps a reused floating pane's newly requested settings and unrelated layout state", async () => {
    const result = await runTemplate(
      { instanceId: "chat:general", title: "#general", settings: { channelId: "general" } },
      [{ instanceId: "chat:general", paneId: "chat", settings: { channelId: "random", fontScale: 2 } },
        { instanceId: "chat:other", paneId: "chat", settings: { channelId: "other" } }],
      true,
    );
    const focusedLayout = result.layouts.at(-1)!;
    expect(findPaneInstance(focusedLayout, "chat:general")?.settings).toEqual({ channelId: "general", fontScale: 2 });
    expect(findPaneInstance(focusedLayout, "chat:other")?.settings).toEqual({ channelId: "other" });
    expect(focusedLayout.floating.find((entry) => entry.instanceId === "chat:general")!.zIndex)
      .toBeGreaterThan(focusedLayout.floating.find((entry) => entry.instanceId === "chat:other")!.zIndex);
    expect(result.created).toBe(0);
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

  // A ticker template's id names the ticker it opened on (`options:AAPL`). Once that pane is linked
  // to a list, or unlinked on another ticker, typing `OMON AAPL` must neither unlink nor take it
  // over, and typing it again must land on the same pinned pane even after it rewrote its settings.
  test("opens one pinned pane beside a stable-id ticker pane that shows another ticker", async () => {
    const spec = { instanceId: "chat:AAPL", title: "OMON AAPL", binding: { kind: "fixed", symbol: "AAPL" } };
    const linked = {
      instanceId: "chat:AAPL",
      paneId: "chat",
      title: "OMON",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    };

    const first = await runTemplate(spec, [linked]);
    expect(first.focused).toEqual([]);
    expect(first.layouts).toEqual([]);
    expect(first.createdWith).toMatchObject({ instanceId: "chat:AAPL:pinned", binding: { kind: "fixed", symbol: "AAPL" } });

    const pinned = { ...spec, instanceId: "chat:AAPL:pinned", paneId: "chat", settings: { expirationTargetKey: "AAPL|AAPL" } };
    const again = await runTemplate(spec, [linked, pinned]);
    expect(again.focused).toEqual(["chat:AAPL:pinned"]);
    expect(again.created).toBe(0);

    const unlinked = await runTemplate(spec, [{ ...linked, title: "OMON MSFT", binding: { kind: "fixed", symbol: "MSFT" } }]);
    expect(unlinked.layouts).toEqual([]);
    expect(unlinked.createdWith).toMatchObject({ instanceId: "chat:AAPL:pinned" });

    // The pinned pane can be linked or moved on too; the next command takes the next id and keeps
    // landing there, instead of opening an unkeyed pane on every repeat.
    const pinnedLinked = { ...pinned, binding: linked.binding };
    const third = await runTemplate(spec, [linked, pinnedLinked]);
    expect(third.layouts).toEqual([]);
    expect(third.createdWith).toMatchObject({ instanceId: "chat:AAPL:pinned-2" });
    const fourth = await runTemplate(spec, [linked, pinnedLinked, { ...pinned, instanceId: "chat:AAPL:pinned-2" }]);
    expect(fourth.focused).toEqual(["chat:AAPL:pinned-2"]);
    expect(fourth.created).toBe(0);
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
      ...workflowDeps(state, {
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
      }),
      persistLayout: (nextLayout) => { persisted.push(nextLayout); },
    });

    expect(applied).toHaveLength(1);
    expect(findPaneInstance(persisted[0]!, pane.instanceId)?.settings).toEqual({
      canonical: { mode: "area" },
    });
  });

  test("stores the pane lock on the instance instead of routing it through pane settings", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-workflow-ops-test");
    const layout = cloneLayout(config.layout);
    const pane = findPaneInstance(layout, "portfolio-list:main");
    if (!pane) throw new Error("missing test pane");
    pane.settings = { canonical: { mode: "line" } };
    const state = createInitialState({ ...config, layout });
    const persisted: LayoutConfig[] = [];
    const applied: unknown[] = [];

    await applyPaneSettingFieldValue(pane.instanceId, {
      key: PANE_LOCK_SETTING_KEY,
      label: "Lock Pane",
      type: "toggle",
    }, true, {
      ...workflowDeps(state, {
        resolvePaneSettings: () => ({
          paneId: pane.instanceId,
          pane,
          paneDef: {
            id: pane.paneId,
            name: "Portfolio List",
            component: () => null,
            defaultPosition: "left",
          },
          rawSettings: pane.settings,
          settingsDef: {
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
            paneType: pane.paneId,
            pane,
            settings: { ...pane.settings },
            paneState: {},
            activeTicker: null,
            activeCollectionId: null,
          },
        }),
      }),
      persistLayout: (nextLayout) => { persisted.push(nextLayout); },
    });

    expect(applied).toHaveLength(0);
    const updated = findPaneInstance(persisted[0]!, pane.instanceId);
    expect(updated?.locked).toBe(true);
    expect(updated?.settings).toEqual({ canonical: { mode: "line" } });
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
      ...workflowDeps(state, {
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
      }),
      persistLayout: () => {},
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
      ...workflowDeps(state, {
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
      }),
      persistLayout: (layout) => { persisted.push(layout); },
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
      ...workflowDeps(state, {
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
      }),
      dispatch: (action) => { actions.push(action); },
      persistLayout: (nextLayout) => { persisted.push(nextLayout); },
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


test("interactive ambiguous ticker input returns to the picker without mutating research or holdings", async () => {
  const state = createInitialState(createDefaultConfig(":memory:"));
  let writes = 0;
  const resolved = await resolveTickerInput("GLD", null, null, {
    getState: () => state, dispatch: () => { writes++; }, pluginRegistry: {} as any,
    tickerRepository: { createTicker: async () => { writes++; throw new Error("Must not create ticker"); } } as any,
    dataProvider: createTestDataProvider({ search: async () => ["BYMA", "NYSE"].map((exchange) => ({ providerId: "cloud", symbol: "GLD", exchange, name: "SPDR", type: "ETF" })) }),
  });
  expect(resolved).toBeNull();
  expect(writes).toBe(0);
});

test("form ticker resolution preserves competing listing identities instead of claiming no match", async () => {
  const state = createInitialState(createDefaultConfig(":memory:"));
  let writes = 0;
  const deps = {
    getState: () => state, dispatch: () => { writes++; }, pluginRegistry: {} as any,
    tickerRepository: { createTicker: async () => { writes++; throw new Error("Must not create ticker"); } } as any,
    dataProvider: createTestDataProvider({ search: async () => [
      { providerId: "cloud", symbol: "COST", exchange: "NASDAQ", name: "Costco Wholesale", type: "Common Stock" },
      { providerId: "cloud", symbol: "COST", exchange: "LSE", name: "Costain Group", type: "Common Stock" },
    ] }),
  };
  const error = await resolveTickerInputOrThrow("COST", null, null, deps).catch((error) => error);
  expect(error.name).toBe("AmbiguousTickerError");
  expect(error.listings).toEqual(["COST:XNAS", "COST:XLON"]);
  expect(error.listingNames).toEqual({ "COST:XNAS": "Costco Wholesale", "COST:XLON": "Costain Group" });
  expect(writes).toBe(0);
});
