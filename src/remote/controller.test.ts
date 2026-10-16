import { describe, expect, test } from "bun:test";
import type { Dispatch } from "react";
import { appReducer, createInitialState, type AppAction, type AppState } from "../core/state/app/state";
import type { PluginRegistry } from "../plugins/registry";
import { createDefaultConfig } from "../types/config";
import type { TickerFinancials } from "../types/financials";
import type { HeadlessPaneDefinition, PaneDef, PaneTemplateDef } from "../types/plugin";
import { createAppRemoteController } from "./controller";
import type { CapturePane, PaneScreenshotRequest } from "./pane-screenshot";
import type { RemoteControlSchema, RemoteUiNodeSnapshot } from "./types";
import type { RemoteUiRegistry } from "./semantic-tree";

/** What custom views can read here: MOST (a list, no argument) and QQ (tickers, no flags). */
function createViewSources() {
  const loaded: Array<{ source: string; symbols: string[]; options: unknown }> = [];
  const pane = (id: string): PaneDef => ({ id, name: id, component: () => null, defaultPosition: "right" });
  const template = (prefix: string, label: string, headless: HeadlessPaneDefinition): PaneTemplateDef => ({
    id: `${prefix.toLowerCase()}-pane`,
    paneId: prefix.toLowerCase(),
    label,
    description: label,
    shortcut: { prefix, argPlaceholder: "", argKind: "ticker" },
    headless,
  });
  const most = template("MOST", "Market Movers", {
    shape: "rows",
    argument: { kind: "none" },
    options: [{
      key: "list",
      description: "Which list",
      type: "enum",
      values: [{ value: "gainers" }, { value: "losers" }],
      defaultValue: "gainers",
    }],
    load: async (args) => {
      loaded.push({ source: "MOST", symbols: args.symbols, options: args.options });
      return { rows: [{ symbol: "NVDA", change: 0.04 }] };
    },
  });
  const quotes = template("QQ", "Quote Monitor", {
    shape: "rows",
    argument: { kind: "tickers" },
    options: [],
    load: async (args) => {
      loaded.push({ source: "QQ", symbols: args.symbols, options: args.options });
      return { rows: args.symbols.map((symbol) => ({ symbol, price: 1 })) };
    },
  });
  return {
    loaded,
    panes: new Map([most, quotes].map((entry) => [entry.paneId, pane(entry.paneId)])),
    paneTemplates: new Map([most, quotes].map((entry) => [entry.id, entry])),
  };
}

function createRegistryHarness(options: {
  withFloatingPane?: boolean;
  withCustomView?: boolean;
  financials?: TickerFinancials;
  dialogOpen?: boolean;
  capturePane?: CapturePane;
} = {}) {
  const config = {
    ...createDefaultConfig("/tmp/gloom-remote-controller"),
    onboardingComplete: true,
  };
  if (options.withCustomView) {
    config.layout = {
      ...config.layout,
      instances: [...config.layout.instances, {
        instanceId: "custom-view:test",
        paneId: "custom-view",
        binding: { kind: "none" as const },
        settings: { spec: JSON.stringify({ version: 1, source: { pane: "MOST" }, projection: {} }) },
      }],
      floating: [...config.layout.floating, { instanceId: "custom-view:test", x: 1, y: 1, width: 60, height: 20 }],
    };
  }
  if (options.withFloatingPane) {
    const instance = {
      instanceId: "help:test",
      paneId: "help",
      binding: { kind: "none" as const },
    };
    config.layout = {
      ...config.layout,
      instances: [...config.layout.instances, instance],
      floating: [{ instanceId: instance.instanceId, x: 8, y: 4, width: 60, height: 24 }],
    };
  }
  const createdFromTemplate: Array<{ templateId: string; options: unknown }> = [];
  const viewSources = createViewSources();
  let state = createInitialState(config);
  const actions: AppAction[] = [];
  const dispatch: Dispatch<AppAction> = (action) => {
    actions.push(action);
    state = appReducer(state, action);
  };
  const invokedCapabilities: Array<{ capabilityId: string; operationId: string; payload: unknown }> = [];
  const marketDataQueries: Array<{ operation: string; input: unknown }> = [];
  const registry = {
    panes: viewSources.panes,
    paneTemplates: viewSources.paneTemplates,
    commands: new Map(),
    capabilities: {
      manifests: () => [],
      invoke: async (capabilityId: string, operationId: string, payload: unknown) => {
        invokedCapabilities.push({ capabilityId, operationId, payload });
        return { invoked: true, capabilityId, operationId, payload };
      },
    },
    marketData: {
      search: async (query: string) => {
        marketDataQueries.push({ operation: "search", input: { query } });
        return [{
          symbol: "NVDA",
          name: "NVIDIA Corporation",
          exchange: "NASDAQ",
          type: "Equity",
        }];
      },
      getQuote: async (symbol: string, exchange?: string) => {
        marketDataQueries.push({ operation: "quote", input: { symbol, exchange } });
        return { symbol, exchange, price: 180 };
      },
      getTickerFinancials: async (symbol: string, exchange?: string) => {
        marketDataQueries.push({ operation: "financials", input: { symbol, exchange } });
        return options.financials ?? { quote: { symbol, exchange, price: 180 }, annualStatements: [], quarterlyStatements: [] };
      },
    },
    resolvePaneSettings: () => null,
    showPane: () => {},
    focusPane: () => {},
    hidePane: () => {},
    createPaneFromTemplateAsync: async (templateId: string, options: unknown) => {
      createdFromTemplate.push({ templateId, options });
    },
    navigateTicker: () => {},
    pinTicker: () => {},
    selectTicker: () => {},
    switchTab: () => {},
    getTermSize: () => ({ width: 120, height: 40 }),
    updateLayout: (layout: AppState["config"]["layout"]) => {
      dispatch({ type: "UPDATE_LAYOUT", layout });
    },
    applyPaneSettingValue: async () => {},
    notify: () => {},
  } as unknown as PluginRegistry;
  let uiNodes: RemoteUiNodeSnapshot[] = [{ id: "ui:test", role: "button", label: "Test", actions: ["press"] }];
  const invokedUiActions: Array<{ nodeId: string; action: string; input?: unknown }> = [];
  const uiRegistry: RemoteUiRegistry = {
    register: () => {},
    unregister: () => {},
    snapshot: () => uiNodes,
    invoke: async (nodeId, action, input) => {
      invokedUiActions.push({ nodeId, action, input });
      return { nodeId, action, input };
    },
  };
  let dialogOpen = options.dialogOpen === true;
  const controller = createAppRemoteController({
    dispatch,
    getState: () => state,
    pluginRegistry: registry,
    uiRegistry,
    capturePane: options.capturePane,
    isDialogOpen: () => dialogOpen,
    closeTopmostDialog: () => {
      const closed = dialogOpen;
      dialogOpen = false;
      return closed;
    },
  });
  return {
    actions,
    controller,
    createdFromTemplate,
    getState: () => state,
    invokedCapabilities,
    invokedUiActions,
    marketDataQueries,
    viewLoads: viewSources.loaded,
    setUiNodes: (nodes: RemoteUiNodeSnapshot[]) => {
      uiNodes = nodes;
    },
  };
}

describe("createAppRemoteController", () => {
  test("exposes schema, app snapshot, and semantic UI tree", async () => {
    const { controller } = createRegistryHarness();

    const schema = await controller.handle({ type: "schema" });
    expect(schema.ok).toBe(true);
    if (schema.ok) {
      const data = schema.data as RemoteControlSchema;
      expect(data.resources.some((resource) => resource.uri === "ui://tree")).toBe(true);
      expect(data.operations.some((operation) => operation.id === "ui.invoke")).toBe(true);
      expect(data.help).toMatchObject({
        title: "Gloomberb remote control guide",
      });
    }

    const help = await controller.handle({ type: "help" });
    expect(help.ok).toBe(true);
    if (help.ok) {
      expect(help.data).toMatchObject({
        batching: expect.any(Object),
      });
    }

    const snapshot = await controller.handle({ type: "get", resource: "app://snapshot" });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      const data = snapshot.data as { ui: unknown[] };
      expect(data.ui).toEqual([{ id: "ui:test", role: "button", label: "Test", actions: ["press"] }]);
      expect(typeof snapshot.rev).toBe("string");
    }
  });

  test("queries configured market data without dispatching app-control actions", async () => {
    const { actions, controller, marketDataQueries } = createRegistryHarness();

    const search = await controller.handle({
      type: "data",
      operation: "search",
      query: "NVIDIA",
    });
    const quote = await controller.handle({
      type: "data",
      operation: "quote",
      symbol: "nvda",
      exchange: "nasdaq",
    });

    expect(search).toMatchObject({
      ok: true,
      data: [{ symbol: "NVDA", exchange: "NASDAQ" }],
    });
    expect(quote).toMatchObject({
      ok: true,
      data: { symbol: "NVDA", exchange: "NASDAQ", price: 180 },
    });
    expect(marketDataQueries).toEqual([
      { operation: "search", input: { query: "NVIDIA" } },
      { operation: "quote", input: { symbol: "NVDA", exchange: "NASDAQ" } },
    ]);
    expect(actions).toEqual([]);

    const appControlAttempt = await controller.handle({
      type: "data",
      operation: "app.openCommandBar",
      query: "NVDA",
    } as never);
    expect(appControlAttempt).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Unknown market data operation") },
    });
    expect(actions).toEqual([]);
  });

  test("financials tools retain reporting currency and coverage independently of the listing quote", async () => {
    const financials: TickerFinancials = {
      financialCurrency: "JPY",
      quote: { symbol: "ACME", price: 30, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1_789_200_000_000 },
      statementHistory: { mode: "extended", source: "sec", status: "retryable-failure", fetchedAt: "2026-09-12T12:00:00Z", reason: "Extended history unavailable" },
      annualStatements: Array.from({ length: 6 }, (_, index) => ({ date: `${2026 - index}-03-31`, totalRevenue: 10_000_000_000 })),
      quarterlyStatements: [], priceHistory: [],
    };
    const { controller, actions, marketDataQueries } = createRegistryHarness({ financials });
    const result = await controller.handle({ type: "data", operation: "financials", symbol: "acme", exchange: "nyse" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const data = JSON.parse(JSON.stringify(result.data));
    expect(data.financialCurrency).toBe("JPY");
    expect(data.quote.currency).toBe("USD");
    expect(data.annualStatements[0]).toEqual({ date: "2026-03-31", totalRevenue: 10_000_000_000 });
    expect(data.annualStatements).toHaveLength(5);
    expect(data.statementHistory).toEqual(financials.statementHistory);
    expect(marketDataQueries).toEqual([{ operation: "financials", input: { symbol: "ACME", exchange: "NYSE" } }]);
    expect(actions).toEqual([]);
  });

  test("financials tools retain metadata-only observations without inventing a quote or statement currency", async () => {
    const financials: TickerFinancials = {
      quoteMetadata: { symbol: "ACME", currency: "USD", instrumentType: "EQUITY", source: { providerId: "cloud", stale: true, lastUpdated: 1_789_200_000_000 } },
      annualStatements: [{ date: "2026-03-31", totalRevenue: 10_000_000_000 }],
      quarterlyStatements: [], priceHistory: [],
    };
    const { controller } = createRegistryHarness({ financials });
    const result = await controller.handle({ type: "data", operation: "financials", symbol: "ACME" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const data = JSON.parse(JSON.stringify(result.data));
    expect(data.quoteMetadata).toEqual(financials.quoteMetadata);
    expect(data).not.toHaveProperty("quote");
    expect(data).not.toHaveProperty("financialCurrency");
    expect(data).not.toHaveProperty("statementHistory");
    expect(data.annualStatements[0]).not.toHaveProperty("currency");
  });

  test("dispatches semantic app operations", async () => {
    const { actions, controller, getState } = createRegistryHarness();

    const response = await controller.handle({
      type: "call",
      operation: "app.openCommandBar",
      input: { query: "NVDA" },
    });

    expect(response.ok).toBe(true);
    expect(actions).toContainEqual({ type: "SET_COMMAND_BAR", open: true, query: "NVDA" });
    expect(getState().commandBarOpen).toBe(true);
    expect(getState().commandBarQuery).toBe("NVDA");
    if (response.ok) {
      expect(response.state?.commandBar).toMatchObject({
        open: true,
        stateQuery: "NVDA",
      });
    }
  });

  test("opens ticker search without requiring command-bar prefix syntax", async () => {
    const { actions, controller, getState } = createRegistryHarness();

    const response = await controller.handle({
      type: "call",
      operation: "app.search",
      input: { mode: "ticker", query: "google" },
    });

    expect(response.ok).toBe(true);
    expect(actions).toContainEqual({
      type: "SET_COMMAND_BAR",
      open: true,
      launch: { kind: "ticker-search", query: "google" },
    });
    expect(getState().commandBarOpen).toBe(true);
    expect(getState().commandBarLaunchRequest).toMatchObject({
      kind: "ticker-search",
      query: "google",
    });
  });

  test("leaves the bar shut while a dialog is open, and says so until app.closeDialog closes it", async () => {
    const { actions, controller } = createRegistryHarness({ dialogOpen: true });

    // Pane settings: a dialog that is not a form.
    expect(await controller.handle({ type: "get", resource: "app://form" }))
      .toMatchObject({ ok: true, data: { open: false, otherDialogOpen: true } });
    for (const operation of ["app.openCommandBar", "app.search"]) {
      const response = await controller.handle({ type: "call", operation, input: { query: "NVDA" } });
      expect(response).toMatchObject({ ok: false, error: { message: "A dialog is open. Close it first with app.closeDialog." } });
    }
    expect(actions).toEqual([]);

    const closed = await controller.handle({ type: "call", operation: "app.closeDialog", input: {} });
    expect(closed.ok && closed.state?.form).toEqual({ open: false });
    expect(await controller.handle({ type: "call", operation: "app.closeDialog", input: {} }))
      .toMatchObject({ ok: false, error: { message: "No dialog is open." } });
    expect((await controller.handle({ type: "call", operation: "app.search", input: { query: "NVDA" } })).ok).toBe(true);
  });

  test("exposes and activates semantic command-bar results", async () => {
    const { controller, invokedUiActions, setUiNodes } = createRegistryHarness();
    setUiNodes([
      {
        id: "ui:input",
        role: "input",
        actions: ["setValue"],
        metadata: { value: "T google", focused: true },
      },
      {
        id: "ui:goog",
        role: "command-bar-result",
        label: "GOOG",
        actions: ["activate"],
        metadata: {
          index: 1,
          selected: false,
          item: {
            id: "ticker:GOOG",
            label: "GOOG",
            detail: "Alphabet Inc.",
            category: "Primary Listing",
            kind: "ticker",
            right: "Equity NASDAQ",
          },
        },
      },
    ]);

    const results = await controller.handle({ type: "get", resource: "app://command-bar/results" });
    expect(results.ok).toBe(true);
    if (results.ok) {
      expect(results.data).toMatchObject([
        {
          nodeId: "ui:goog",
          index: 1,
          label: "GOOG",
          kind: "ticker",
          right: "Equity NASDAQ",
        },
      ]);
    }

    const activated = await controller.handle({
      type: "call",
      operation: "commandBar.activateResult",
      input: { index: 1 },
    });
    expect(activated.ok).toBe(true);
    expect(invokedUiActions).toContainEqual({ nodeId: "ui:goog", action: "activate", input: undefined });
  });

  test("scopes command-bar query reads to the command-bar input", async () => {
    const { controller, setUiNodes } = createRegistryHarness();
    setUiNodes([
      {
        id: "ui:pane-input",
        role: "input",
        actions: ["setValue"],
        metadata: { value: "pane search", focused: true },
      },
      {
        id: "ui:command-input",
        role: "input",
        actions: ["setValue"],
        metadata: { value: "theme", focused: true, scope: "command-bar" },
      },
    ]);

    const response = await controller.handle({ type: "get", resource: "app://command-bar" });
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect((response.data as { query: string }).query).toBe("theme");
    }
  });

  test("exposes shared list items as command-bar results", async () => {
    const { controller, invokedUiActions, setUiNodes } = createRegistryHarness();
    setUiNodes([
      {
        id: "ui:theme-list",
        role: "list",
        label: "Theme picker",
        actions: ["activate", "select"],
        metadata: {
          scope: "command-bar",
          selectedIndex: 1,
          itemKind: "theme",
          items: [
            { index: 0, id: "github-dark", label: "GitHub Dark", kind: "theme", category: "Themes" },
            { index: 1, id: "github-light", label: "GitHub Light", kind: "theme", category: "Themes", current: true },
          ],
        },
      },
    ]);

    const results = await controller.handle({ type: "get", resource: "app://command-bar/results" });
    expect(results.ok).toBe(true);
    if (results.ok) {
      expect(results.data).toMatchObject([
        { nodeId: "ui:theme-list", index: 0, label: "GitHub Dark", kind: "theme", itemId: "github-dark" },
        { nodeId: "ui:theme-list", index: 1, label: "GitHub Light", kind: "theme", itemId: "github-light", selected: true },
      ]);
    }

    const activated = await controller.handle({
      type: "call",
      operation: "commandBar.activateResult",
      input: { label: "GitHub Light" },
    });
    expect(activated.ok).toBe(true);
    expect(invokedUiActions).toContainEqual({
      nodeId: "ui:theme-list",
      action: "activate",
      input: { index: 1, id: "github-light", label: "GitHub Light" },
    });
  });

  test("invokes semantic UI nodes by selector", async () => {
    const { controller, invokedUiActions, setUiNodes } = createRegistryHarness();
    setUiNodes([
      { id: "ui:cancel", role: "button", label: "Cancel", actions: ["press"] },
      { id: "ui:done", role: "button", label: "Done", actions: ["press"], metadata: { scope: "command-bar" } },
    ]);

    const response = await controller.handle({
      type: "call",
      operation: "ui.invokeMatching",
      input: { role: "button", label: "Done", action: "press" },
    });

    expect(response.ok).toBe(true);
    expect(invokedUiActions).toContainEqual({ nodeId: "ui:done", action: "press", input: undefined });

    // An open form covers the panes: its Cancel is pressed, not a pane's
    // registered earlier, and every call reports the form.
    setUiNodes([
      { id: "ui:pane-cancel", role: "button", label: "Cancel", actions: ["press"] },
      { id: "ui:form-cancel", role: "button", label: "Cancel", actions: ["press"], metadata: { scope: "form" } },
      { id: "ui:form", role: "form", label: "New Watchlist", actions: ["cancel", "submit"], metadata: { scope: "form", kind: "form", title: "New Watchlist" } },
    ]);
    const formResponse = await controller.handle({
      type: "call",
      operation: "ui.invokeMatching",
      input: { role: "button", label: "Cancel" },
    });
    expect(invokedUiActions.at(-1)).toMatchObject({ nodeId: "ui:form-cancel", action: "press" });
    expect(formResponse.ok && formResponse.state?.form).toEqual({
      open: true,
      nodeId: "ui:form",
      actions: ["cancel", "submit"],
      kind: "form",
      title: "New Watchlist",
    });

    // A listing picker over the form: the form's controls are out of reach.
    setUiNodes([
      { id: "ui:form-cancel", role: "button", label: "Cancel", actions: ["press"], metadata: { scope: "form" } },
      { id: "ui:form", role: "form", label: "Compare", actions: ["cancel", "submit"], metadata: { scope: "form", kind: "form", covered: true } },
    ]);
    const covered = await controller.handle({
      type: "call",
      operation: "ui.invokeMatching",
      input: { role: "button", label: "Cancel" },
    });
    expect(covered).toMatchObject({ ok: false, error: { message: "No matching semantic UI node is visible." } });
    expect((await controller.handle({ type: "get", resource: "app://form" })))
      .toMatchObject({ ok: true, data: { open: true, kind: "form", covered: true } });

    const directResponse = await controller.handle({
      type: "call",
      operation: "ui.invoke",
      input: { nodeId: "ui:done", action: "press" },
    });
    expect(directResponse.ok).toBe(true);
    if (directResponse.ok) {
      expect(directResponse.data).toMatchObject({
        ok: true,
        result: { nodeId: "ui:done", action: "press" },
      });
    }
  });

  test("forwards plugin capability operations without narrowing their payload", async () => {
    const { controller, invokedCapabilities } = createRegistryHarness();
    const payload = {
      instanceId: "broker-main",
      operation: "placeOrder",
      args: [{ symbol: "NVDA", side: "BUY", quantity: 5 }],
    };

    const response = await controller.handle({
      type: "call",
      operation: "capability.invoke",
      input: {
        capabilityId: "desktop.broker",
        operationId: "invoke",
        payload,
      },
    });

    expect(response.ok).toBe(true);
    expect(invokedCapabilities).toEqual([{
      capabilityId: "desktop.broker",
      operationId: "invoke",
      payload,
    }]);
    if (response.ok) {
      expect(response.data).toEqual({
        invoked: true,
        capabilityId: "desktop.broker",
        operationId: "invoke",
        payload,
      });
    }
  });

  test("runs sequential batches with halt-on-error and final state", async () => {
    const { controller } = createRegistryHarness();

    const response = await controller.handle({
      type: "batch",
      include: ["commandBar"],
      requests: [
        { type: "call", operation: "app.openCommandBar", input: { query: "theme" } },
        { type: "call", operation: "missing.operation", input: {} },
        { type: "call", operation: "app.closeCommandBar", input: {} },
      ],
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({
        ok: false,
        haltedAt: 1,
      });
      expect((response.data as { responses: unknown[] }).responses).toHaveLength(2);
      expect(response.state?.commandBar).toMatchObject({
        open: true,
      });
    }
  });

  test("patches pane runtime state with replace semantics", async () => {
    const { controller, getState } = createRegistryHarness();
    const paneId = getState().config.layout.instances[0]!.instanceId;
    await controller.handle({
      type: "call",
      operation: "pane.setState",
      input: { paneId, patch: { cursorSymbol: "NVDA", stale: true } },
    });

    const response = await controller.handle({
      type: "patch",
      resource: `app://pane-state/${encodeURIComponent(paneId)}`,
      patch: [{ op: "remove", path: "/stale" }],
    });

    expect(response.ok).toBe(true);
    expect(getState().paneState[paneId]).toMatchObject({ cursorSymbol: "NVDA" });
    expect(getState().paneState[paneId]?.stale).toBeUndefined();
  });

  test("closes floating panes and grids visible panes through layout helpers", async () => {
    const { controller, getState } = createRegistryHarness({ withFloatingPane: true });
    expect(getState().config.layout.floating.length).toBeGreaterThan(0);

    const closeResponse = await controller.handle({
      type: "call",
      operation: "layout.closeFloating",
      input: {},
    });
    expect(closeResponse.ok).toBe(true);
    expect(getState().config.layout.floating).toEqual([]);

    const paneIds = getState().config.layout.instances.slice(0, 4).map((pane) => pane.instanceId);
    const gridResponse = await controller.handle({
      type: "call",
      operation: "layout.setGrid",
      input: { paneIds, columns: 2 },
    });
    expect(gridResponse.ok).toBe(true);
    expect(getState().config.layout.dockRoot).toMatchObject({
      kind: "split",
      axis: "vertical",
    });
  });

  test("pane.screenshot paints the focused pane or the one asked for, within the size bounds; the TUI answers unsupported", async () => {
    const requests: PaneScreenshotRequest[] = [];
    const capturePane: CapturePane = async (request) => {
      requests.push(request);
      return { pngBase64: "iVBORw0KGgo=", width: 800, height: 600, bytes: 9, screen: { width: 400, height: 300 }, reduced: false };
    };
    const { controller, getState } = createRegistryHarness({ withFloatingPane: true, capturePane });
    const call = (input: Record<string, unknown>) => controller.handle({ type: "call", operation: "pane.screenshot", input });

    const focused = await call({});
    expect(focused.ok).toBe(true);
    expect(requests[0]!.instanceId).toBe(getState().focusedPaneId!);
    // A read: the answer carries no layout or command-bar state.
    if (focused.ok) expect(focused.state).toBeUndefined();

    const asked = await call({ paneId: "help" });
    expect(asked.ok && asked.data).toMatchObject({
      pane: { instanceId: "help:test", paneId: "help" },
      image: { mimeType: "image/png", data: "iVBORw0KGgo=", width: 800, height: 600, bytes: 9 },
      screen: { width: 400, height: 300 },
    });
    // Twice the screen size by default, the long edge within 1600 px, and width honoured up to 3x.
    const scale = requests[1]!.scaleFor;
    expect(scale({ width: 400, height: 300 })).toBe(2);
    expect(scale({ width: 1200, height: 900 })).toBeCloseTo(1600 / 1200);
    expect(scale({ width: 300, height: 2000 })).toBeCloseTo(0.8);
    await call({ paneId: "help:test", width: 1600 });
    expect(requests[2]!.scaleFor({ width: 400, height: 300 })).toBe(3);
    expect(requests[2]!.maxBytes).toBe(512 * 1024);

    for (const input of [{ width: 199 }, { width: 1601 }, { width: 640.5 }, { paneId: "nope" }]) {
      const refused = await call(input);
      expect(refused.ok).toBe(false);
    }
    expect(requests).toHaveLength(3);

    const tui = await createRegistryHarness().controller.handle({ type: "call", operation: "pane.screenshot", input: {} });
    expect(tui.ok).toBe(false);
    if (!tui.ok) {
      expect(tui.error.code).toBe("unsupported");
      expect(tui.error.message).toContain("desktop app");
    }
  });
});

describe("view operations", () => {
  const spec = {
    source: { pane: "MOST", options: { list: "gainers" } },
    projection: { columns: ["symbol", { key: "change", transform: "percent" }], sort: { by: "change", direction: "desc" } },
    presentation: { title: "Movers" },
  };

  test("view.create loads the source, then opens the custom view template", async () => {
    const { controller, createdFromTemplate, viewLoads } = createRegistryHarness();
    const result = await controller.handle({ type: "call", operation: "view.create", input: { name: "Top movers", spec } });
    expect(result.ok).toBe(true);
    expect(viewLoads).toEqual([{ source: "MOST", symbols: [], options: { list: "gainers" } }]);
    expect(createdFromTemplate).toHaveLength(1);
    expect(createdFromTemplate[0]?.templateId).toBe("custom-view-pane");
    const options = createdFromTemplate[0]?.options as { values: { spec: string; title: string } };
    expect(options.values.title).toBe("Top movers");
    expect(JSON.parse(options.values.spec)).toMatchObject({
      version: 1,
      source: { kind: "inline", pane: "MOST", options: { list: "gainers" } },
      projection: { columns: [{ key: "symbol" }, { key: "change", transform: "percent" }] },
    });

    const invalid = await controller.handle({ type: "call", operation: "view.create", input: { spec: { source: { pane: "" } } } });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.message).toContain("source.pane");
    expect(createdFromTemplate).toHaveLength(1);
  });

  test("view.create answers a source that is not a function with the valid ones and opens nothing", async () => {
    const { controller, createdFromTemplate } = createRegistryHarness();
    const result = await controller.handle({
      type: "call",
      operation: "view.create",
      input: { spec: { source: { pane: "market_screener" }, projection: {} } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Unknown source "market_screener"');
      expect(result.error.message).toContain("Closest: MOST (Market Movers)");
      expect(result.error.message).toContain("no argument: MOST; tickers: QQ");
    }
    expect(createdFromTemplate).toHaveLength(0);
  });

  test("view.create gives the source its own usage error, or an option's allowed values, and opens nothing", async () => {
    const { controller, createdFromTemplate } = createRegistryHarness();
    const create = (source: object) => controller.handle({ type: "call", operation: "view.create", input: { spec: { source, projection: {} } } });

    const noArgument = await create({ pane: "QQ" });
    expect(noArgument.ok).toBe(false);
    if (!noArgument.ok) expect(noArgument.error.message).toContain("Usage: gloomberb fn QQ <symbol>");

    const badOption = await create({ pane: "MOST", options: { list: "stale" } });
    expect(badOption.ok).toBe(false);
    if (!badOption.ok) expect(badOption.error.message).toContain("Use one of: gainers, losers.");
    expect(createdFromTemplate).toHaveLength(0);
  });

  test("a list argument reaches the function as the words typed after its code", async () => {
    const { controller, createdFromTemplate, viewLoads } = createRegistryHarness();
    const result = await controller.handle({
      type: "call",
      operation: "view.create",
      input: { spec: { source: { pane: "QQ", argument: ["CME", "AAPL"] }, projection: {} } },
    });
    expect(result.ok).toBe(true);
    expect(viewLoads).toEqual([{ source: "QQ", symbols: ["CME", "AAPL"], options: {} }]);
    const options = createdFromTemplate[0]?.options as { values: { spec: string } };
    expect(JSON.parse(options.values.spec).source.argument).toBe("CME AAPL");
  });

  test("view.update rewrites the spec of an existing custom view only", async () => {
    const { controller, getState } = createRegistryHarness({ withCustomView: true });
    const result = await controller.handle({
      type: "call",
      operation: "view.update",
      input: { paneId: "custom-view:test", spec: { ...spec, projection: { limit: 5 } }, name: "Five movers" },
    });
    expect(result.ok).toBe(true);
    const instance = getState().config.layout.instances.find((entry) => entry.instanceId === "custom-view:test");
    expect(instance?.title).toBe("Five movers");
    expect(JSON.parse(String(instance?.settings?.spec))).toMatchObject({ projection: { limit: 5 } });

    const notAView = await controller.handle({
      type: "call",
      operation: "view.update",
      input: { paneId: getState().config.layout.instances[0]!.instanceId, spec },
    });
    expect(notAView.ok).toBe(false);
    if (!notAView.ok) expect(notAView.error.message).toContain("not a custom view");
  });

  test("view.update with a source that cannot load leaves the working spec as it was", async () => {
    const { controller, getState } = createRegistryHarness({ withCustomView: true });
    const before = getState().config.layout.instances.find((entry) => entry.instanceId === "custom-view:test")?.settings?.spec;
    const result = await controller.handle({
      type: "call",
      operation: "view.update",
      input: { paneId: "custom-view:test", spec: { source: { pane: "market_screener" }, projection: {} }, name: "Broken" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Unknown source "market_screener"');
    const after = getState().config.layout.instances.find((entry) => entry.instanceId === "custom-view:test");
    expect(after?.settings?.spec).toBe(before);
    expect(after?.title).toBeUndefined();
  });
});
