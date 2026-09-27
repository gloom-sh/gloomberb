import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState, resolveCollectionForPane, resolveTickerForPane } from "./state";
import { cloneLayout, createBlankLayout, createDefaultConfig, createPaneInstance, findPaneInstance } from "../../../types/config";
import type { AppSessionSnapshot } from "../session-persistence";
import { removePane } from "../../../plugins/pane-manager";
import { buildBrokerPortfolioId } from "../../../utils/broker-instances";
import { createTestFinancials } from "../../../test-support/data-provider";

describe("resolveTickerForPane", () => {
  test("uses a portfolio pane cursor for inspector follow panes", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const state = createInitialState(config);

    state.paneState["portfolio-list:main"] = {
      collectionId: "main",
      cursorSymbol: "AAPL",
    };

    expect(resolveTickerForPane(state, "portfolio-list:main")).toBe("AAPL");
    expect(resolveTickerForPane(state, "ticker-detail:main")).toBe("AAPL");
  });

  test("follows cursor symbols from any ticker source pane", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const source = createPaneInstance("ai-screener", {
      instanceId: "ai-screener:main",
      binding: { kind: "none" },
    });
    const follower = createPaneInstance("ticker-detail", {
      instanceId: "ticker-detail:screener",
      binding: { kind: "follow", sourceInstanceId: source.instanceId },
    });
    config.layout.instances.push(source, follower);
    config.layout.floating.push(
      { instanceId: source.instanceId, x: 0, y: 0, width: 40, height: 12 },
      { instanceId: follower.instanceId, x: 1, y: 1, width: 40, height: 12 },
    );

    const state = createInitialState(config);
    state.paneState[source.instanceId] = { cursorSymbol: "NVDA" };

    expect(resolveTickerForPane(state, source.instanceId)).toBe("NVDA");
    expect(resolveTickerForPane(state, follower.instanceId)).toBe("NVDA");
  });

  test("pins a follower to its last ticker when its source closes", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const state = createInitialState(config);
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };

    const next = appReducer(state, {
      type: "UPDATE_LAYOUT",
      layout: removePane(state.config.layout, "portfolio-list:main"),
    });

    expect(findPaneInstance(next.config.layout, "ticker-detail:main")?.binding).toEqual({
      kind: "fixed",
      symbol: "AAPL",
    });
  });

  test("uses fixed ticker bindings for pinned panes", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const instance = createPaneInstance("ticker-detail", {
      instanceId: "ticker-detail:msft",
      binding: { kind: "fixed", symbol: "MSFT" },
    });
    config.layout.instances.push(instance);
    config.layout.floating.push({
      instanceId: instance.instanceId,
      x: 0,
      y: 0,
      width: 40,
      height: 12,
    });

    const state = createInitialState(config);
    expect(resolveTickerForPane(state, instance.instanceId)).toBe("MSFT");
  });

  test("hydrates remembered pane-local tab and sort state from the previous session", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const sessionSnapshot: AppSessionSnapshot = {
      paneState: {
        "portfolio-list:main": {
          collectionId: "watchlist",
          collectionSorts: {
            watchlist: { columnId: "change_pct", direction: "desc" },
          },
        },
        "ticker-detail:main": {
          activeTabId: "financials",
        },
      },
      focusedPaneId: "ticker-detail:main",
      activePanel: "right",
      statusBarVisible: true,
      openPaneIds: ["portfolio-list:main", "ticker-detail:main"],
      hydrationTargets: [],
      exchangeCurrencies: ["USD"],
      savedAt: Date.now(),
    };

    const state = createInitialState(config, sessionSnapshot);

    expect(state.paneState["portfolio-list:main"]).toEqual({
      collectionId: "watchlist",
      cursorSymbol: null,
      collectionSorts: {
        watchlist: { columnId: "change_pct", direction: "desc" },
      },
    });
    expect(state.paneState["ticker-detail:main"]).toEqual({
      activeTabId: "financials",
    });
    expect(state.focusedPaneId).toBe("ticker-detail:main");
  });

  test("raises the session-focused floating pane above stale saved z-order", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.layout = {
      ...config.layout,
      dockRoot: null,
      floating: [
        { instanceId: "ticker-detail:main", x: 4, y: 2, width: 60, height: 22, zIndex: 5 },
        { instanceId: "chat:main", x: 8, y: 4, width: 48, height: 18, zIndex: 20 },
      ],
    };
    config.layouts = config.layouts.map((entry, index) => (
      index === config.activeLayoutIndex ? { ...entry, layout: cloneLayout(config.layout) } : entry
    ));
    const sessionSnapshot: AppSessionSnapshot = {
      paneState: {},
      focusedPaneId: "ticker-detail:main",
      activePanel: "right",
      statusBarVisible: true,
      openPaneIds: ["ticker-detail:main", "chat:main"],
      hydrationTargets: [],
      exchangeCurrencies: ["USD"],
      savedAt: Date.now(),
    };

    const state = createInitialState(config, sessionSnapshot);
    const tickerEntry = state.config.layout.floating.find((entry) => entry.instanceId === "ticker-detail:main");
    const chatEntry = state.config.layout.floating.find((entry) => entry.instanceId === "chat:main");

    expect(tickerEntry?.zIndex).toBe(21);
    expect((tickerEntry?.zIndex ?? 0) > (chatEntry?.zIndex ?? 0)).toBe(true);
    expect(state.config.layouts[state.config.activeLayoutIndex]?.layout.floating.find(
      (entry) => entry.instanceId === "ticker-detail:main",
    )?.zIndex).toBe(21);
  });

  test("preserves broker portfolio selection until broker portfolios are restored", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const brokerPortfolioId = buildBrokerPortfolioId("ibkr-live", "DU12345");
    const sessionSnapshot: AppSessionSnapshot = {
      paneState: {
        "portfolio-list:main": {
          collectionId: brokerPortfolioId,
          cursorSymbol: "AAPL",
        },
      },
      focusedPaneId: "portfolio-list:main",
      activePanel: "left",
      statusBarVisible: true,
      openPaneIds: ["portfolio-list:main", "ticker-detail:main"],
      hydrationTargets: [],
      exchangeCurrencies: ["USD"],
      savedAt: Date.now(),
    };

    const initial = createInitialState(config, sessionSnapshot);

    expect(initial.paneState["portfolio-list:main"]).toEqual({
      collectionId: brokerPortfolioId,
      cursorSymbol: "AAPL",
    });
    expect(resolveCollectionForPane(initial, "portfolio-list:main")).toBe(brokerPortfolioId);
    expect(resolveCollectionForPane(initial, "ticker-detail:main")).toBe(brokerPortfolioId);

    const nextConfig = {
      ...config,
      portfolios: [
        ...config.portfolios,
        {
          id: brokerPortfolioId,
          name: "IBKR DU12345",
          currency: "USD",
          brokerId: "ibkr",
          brokerInstanceId: "ibkr-live",
          brokerAccountId: "DU12345",
        },
      ],
    };

    const next = appReducer(initial, { type: "SET_CONFIG", config: nextConfig });

    expect(next.paneState["portfolio-list:main"]).toEqual({
      collectionId: brokerPortfolioId,
      cursorSymbol: "AAPL",
    });
    expect(resolveCollectionForPane(next, "portfolio-list:main")).toBe(brokerPortfolioId);
  });

  test("falls back for unknown non-broker collection ids", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const sessionSnapshot: AppSessionSnapshot = {
      paneState: {
        "portfolio-list:main": {
          collectionId: "missing-collection",
        },
      },
      focusedPaneId: "portfolio-list:main",
      activePanel: "left",
      statusBarVisible: true,
      openPaneIds: ["portfolio-list:main", "ticker-detail:main"],
      hydrationTargets: [],
      exchangeCurrencies: ["USD"],
      savedAt: Date.now(),
    };

    const state = createInitialState(config, sessionSnapshot);

    expect(state.paneState["portfolio-list:main"]).toEqual({
      collectionId: "main",
      cursorSymbol: null,
    });
    expect(resolveCollectionForPane(state, "portfolio-list:main")).toBe("main");
  });
});

describe("broker account cache", () => {
  test("stores broker accounts by instance id", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const next = appReducer(state, {
      type: "SET_BROKER_ACCOUNTS",
      instanceId: "ibkr-flex",
      accounts: [{ accountId: "DU12345", name: "DU12345", totalCashValue: 10 }],
    });

    expect(next.brokerAccounts).toEqual({
      "ibkr-flex": [{ accountId: "DU12345", name: "DU12345", totalCashValue: 10 }],
    });
  });

  test("preserves cached broker accounts across unrelated config updates", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.brokerInstances.push({
      id: "ibkr-flex",
      brokerType: "ibkr",
      label: "Flex",
      connectionMode: "flex",
      config: { connectionMode: "flex", flex: { token: "t", queryId: "q" } },
      enabled: true,
    });
    const state = appReducer(createInitialState(config), {
      type: "SET_BROKER_ACCOUNTS",
      instanceId: "ibkr-flex",
      accounts: [{ accountId: "DU12345", name: "DU12345", totalCashValue: 10 }],
    });

    const next = appReducer(state, { type: "SET_CONFIG", config: { ...config, theme: "amber" } });

    expect(next.brokerAccounts).toEqual(state.brokerAccounts);
  });

  test("clears cached broker accounts when the broker instance is removed", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.brokerInstances.push({
      id: "ibkr-flex",
      brokerType: "ibkr",
      label: "Flex",
      connectionMode: "flex",
      config: { connectionMode: "flex", flex: { token: "t", queryId: "q" } },
      enabled: true,
    });
    const state = appReducer(createInitialState(config), {
      type: "SET_BROKER_ACCOUNTS",
      instanceId: "ibkr-flex",
      accounts: [{ accountId: "DU12345", name: "DU12345", totalCashValue: 10 }],
    });

    const next = appReducer(state, {
      type: "SET_CONFIG",
      config: { ...config, brokerInstances: [] },
    });

    expect(next.brokerAccounts).toEqual({});
  });
});

describe("pane state updates", () => {
  test("returns the existing state object when a pane patch is a no-op", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    initial.paneState["portfolio-list:main"] = {
      collectionId: "main",
      cursorSymbol: "AAPL",
    };

    const next = appReducer(initial, {
      type: "UPDATE_PANE_STATE",
      paneId: "portfolio-list:main",
      patch: { cursorSymbol: "AAPL" },
    });

    expect(next).toBe(initial);
  });

  test("keeps pane runtime state scoped to each saved layout", () => {
    let state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const originalLayoutIndex = state.config.activeLayoutIndex;

    state = appReducer(state, {
      type: "UPDATE_PANE_STATE",
      paneId: "ticker-detail:main",
      patch: { activeTabId: "chart" },
    });
    state = appReducer(state, { type: "DUPLICATE_LAYOUT", index: originalLayoutIndex });
    const duplicateLayoutIndex = state.config.activeLayoutIndex;

    state = appReducer(state, {
      type: "UPDATE_PANE_STATE",
      paneId: "ticker-detail:main",
      patch: { activeTabId: "financials" },
    });

    expect(state.config.layouts[duplicateLayoutIndex]?.paneState?.["ticker-detail:main"]?.activeTabId).toBe("financials");

    state = appReducer(state, { type: "SWITCH_LAYOUT", index: originalLayoutIndex });
    expect(state.paneState["ticker-detail:main"]?.activeTabId).toBe("chart");
    expect(state.config.layouts[originalLayoutIndex]?.paneState?.["ticker-detail:main"]?.activeTabId).toBe("chart");

    state = appReducer(state, { type: "SWITCH_LAYOUT", index: duplicateLayoutIndex });
    expect(state.paneState["ticker-detail:main"]?.activeTabId).toBe("financials");
  });

  test("hydrates saved layout pane state before legacy session pane state", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.layouts[config.activeLayoutIndex] = {
      ...config.layouts[config.activeLayoutIndex]!,
      paneState: {
        "ticker-detail:main": { activeTabId: "chart" },
      },
      focusedPaneId: "ticker-detail:main",
      activePanel: "right",
    };
    const sessionSnapshot: AppSessionSnapshot = {
      paneState: {
        "ticker-detail:main": { activeTabId: "overview" },
      },
      focusedPaneId: "portfolio-list:main",
      activePanel: "left",
      statusBarVisible: true,
      openPaneIds: ["portfolio-list:main", "ticker-detail:main"],
      hydrationTargets: [],
      exchangeCurrencies: ["USD"],
      savedAt: Date.now(),
    };

    const state = createInitialState(config, sessionSnapshot);

    expect(state.paneState["ticker-detail:main"]?.activeTabId).toBe("chart");
    expect(state.focusedPaneId).toBe("ticker-detail:main");
    expect(state.activePanel).toBe("right");
  });
});

describe("quote merging", () => {
  test("does not overwrite live broker quotes with cloud updates", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const initial = createInitialState(config);
    initial.financials.set("AAPL", createTestFinancials({
      quote: {
        symbol: "AAPL",
        providerId: "ibkr",
        price: 201,
        currency: "USD",
        change: 1,
        changePercent: 0.5,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    }));

    const next = appReducer(initial, {
      type: "MERGE_QUOTE",
      symbol: "AAPL",
      quote: {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 199,
        currency: "USD",
        change: -1,
        changePercent: -0.5,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    });

    expect(next.financials.get("AAPL")?.quote?.price).toBe(201);
    expect(next.financials.get("AAPL")?.quote?.providerId).toBe("ibkr");
  });

  test("merges cloud quotes into existing fundamentals without wiping them", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const initial = createInitialState(config);
    initial.financials.set("AAPL", createTestFinancials({ profile: { description: "Apple" }, fundamentals: { trailingPE: 30 } }));

    const next = appReducer(initial, {
      type: "MERGE_QUOTE",
      symbol: "AAPL",
      quote: {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 200,
        currency: "USD",
        change: 2,
        changePercent: 1,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    });

    expect(next.financials.get("AAPL")?.profile?.description).toBe("Apple");
    expect(next.financials.get("AAPL")?.fundamentals?.trailingPE).toBe(30);
    expect(next.financials.get("AAPL")?.quote?.price).toBe(200);
  });

  test("preserves existing bid ask when a streaming quote only updates last price", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const initial = createInitialState(config);
    initial.financials.set("AAPL", createTestFinancials({
      quote: {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 200,
        currency: "USD",
        change: 2,
        changePercent: 1,
        bid: 199.95,
        ask: 200.05,
        bidSize: 10,
        askSize: 12,
        lastUpdated: Date.now() - 1000,
        dataSource: "delayed",
      },
    }));

    const next = appReducer(initial, {
      type: "MERGE_QUOTE",
      symbol: "AAPL",
      quote: {
        symbol: "AAPL",
        providerId: "gloomberb-cloud",
        price: 201,
        currency: "USD",
        change: 3,
        changePercent: 1.5,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    });

    expect(next.financials.get("AAPL")?.quote?.price).toBe(201);
    expect(next.financials.get("AAPL")?.quote?.bid).toBe(199.95);
    expect(next.financials.get("AAPL")?.quote?.ask).toBe(200.05);
    expect(next.financials.get("AAPL")?.quote?.bidSize).toBe(10);
    expect(next.financials.get("AAPL")?.quote?.askSize).toBe(12);
  });

  test("ignores same-currency quotes that differ by a likely 100x unit mismatch", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const initial = createInitialState(config);
    initial.financials.set("IQE", createTestFinancials({
      quote: {
        symbol: "IQE.L",
        providerId: "yahoo",
        price: 0.245,
        currency: "GBP",
        change: -0.021,
        changePercent: -7.89,
        lastUpdated: Date.now() - 1000,
        dataSource: "delayed",
      },
    }));

    const next = appReducer(initial, {
      type: "MERGE_QUOTE",
      symbol: "IQE",
      quote: {
        symbol: "IQE",
        providerId: "gloomberb-cloud",
        price: 24.5,
        currency: "GBP",
        change: -2.1,
        changePercent: -7.89,
        lastUpdated: Date.now(),
        dataSource: "live",
      },
    });

    expect(next.financials.get("IQE")?.quote?.price).toBe(0.245);
    expect(next.financials.get("IQE")?.quote?.symbol).toBe("IQE.L");
    expect(next.financials.get("IQE")?.quote?.dataSource).toBe("delayed");
  });
});

describe("layout focus fallback", () => {
  test("switching to an old layout without focused metadata uses that layout's top floating pane", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const targetLayout = {
      ...cloneLayout(config.layout),
      dockRoot: null,
      floating: [
        { instanceId: "chat:main", x: 4, y: 2, width: 36, height: 10, zIndex: 70 },
        { instanceId: "ticker-detail:main", x: 12, y: 4, width: 36, height: 10, zIndex: 95 },
      ],
    };
    config.layouts = [
      { name: "Current", layout: cloneLayout(config.layout), paneState: {} },
      { name: "Floating", layout: cloneLayout(targetLayout), paneState: {} },
    ];
    config.activeLayoutIndex = 0;

    let state = createInitialState(config);
    state = appReducer(state, { type: "FOCUS_PANE", paneId: "chat:main" });
    state = appReducer(state, { type: "SWITCH_LAYOUT", index: 1 });

    const chatEntry = state.config.layout.floating.find((entry) => entry.instanceId === "chat:main");
    const tickerEntry = state.config.layout.floating.find((entry) => entry.instanceId === "ticker-detail:main");
    expect(state.focusedPaneId).toBe("ticker-detail:main");
    expect((tickerEntry?.zIndex ?? 0) > (chatEntry?.zIndex ?? 0)).toBe(true);
  });

  test("starts with the top floating pane focused when no session pane is active", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const layout = {
      ...cloneLayout(config.layout),
      dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
      floating: [
        { instanceId: "chat:main", x: 4, y: 2, width: 36, height: 10, zIndex: 70 },
        { instanceId: "ticker-detail:main", x: 12, y: 4, width: 36, height: 10, zIndex: 95 },
      ],
    };

    const state = createInitialState({
      ...config,
      layout,
      layouts: [{ name: "Default", layout: cloneLayout(layout) }],
    });

    expect(state.focusedPaneId).toBe("ticker-detail:main");
  });

  test("focuses the highest remaining floating pane when the focused floating pane closes", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const backgroundPane = createPaneInstance("chat", {
      instanceId: "chat:background",
      binding: { kind: "none" },
    });
    const topPane = createPaneInstance("help", {
      instanceId: "help:top",
      binding: { kind: "none" },
    });
    const layout = {
      ...cloneLayout(config.layout),
      instances: [...config.layout.instances, backgroundPane, topPane],
      floating: [
        { instanceId: "chat:background", x: 4, y: 2, width: 36, height: 10, zIndex: 70 },
        { instanceId: "help:top", x: 12, y: 4, width: 36, height: 10, zIndex: 95 },
      ],
    };
    const state = createInitialState({
      ...config,
      layout,
      layouts: [{ name: "Default", layout: cloneLayout(layout) }],
    });
    state.focusedPaneId = "help:top";

    const nextLayout = {
      ...cloneLayout(layout),
      instances: layout.instances.filter((instance) => instance.instanceId !== "help:top"),
      floating: layout.floating.filter((entry) => entry.instanceId !== "help:top"),
    };
    const next = appReducer(state, { type: "UPDATE_LAYOUT", layout: nextLayout });

    expect(next.focusedPaneId).toBe("chat:background");
  });
});

describe("layout history", () => {
  test("tracks layout undo and redo history", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const defaultRatio = initial.config.layout.dockRoot && initial.config.layout.dockRoot.kind === "split"
      ? initial.config.layout.dockRoot.ratio
      : null;
    const changedLayout = cloneLayout(initial.config.layout);
    if (!changedLayout.dockRoot || changedLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    changedLayout.dockRoot.ratio = 0.5;

    const withHistory = appReducer(initial, { type: "PUSH_LAYOUT_HISTORY" });
    const changed = appReducer(withHistory, { type: "UPDATE_LAYOUT", layout: changedLayout });

    expect(changed.layoutHistory[0]?.past).toHaveLength(1);
    expect(changed.config.layout.dockRoot && changed.config.layout.dockRoot.kind === "split"
      ? changed.config.layout.dockRoot.ratio
      : null).toBe(0.5);

    const undone = appReducer(changed, { type: "UNDO_LAYOUT" });
    expect(undone.config.layout.dockRoot && undone.config.layout.dockRoot.kind === "split"
      ? undone.config.layout.dockRoot.ratio
      : null).toBe(defaultRatio);
    expect(undone.layoutHistory[0]?.future).toHaveLength(1);

    const redone = appReducer(undone, { type: "REDO_LAYOUT" });
    expect(redone.config.layout.dockRoot && redone.config.layout.dockRoot.kind === "split"
      ? redone.config.layout.dockRoot.ratio
      : null).toBe(0.5);
    expect(redone.layoutHistory[0]?.past).toHaveLength(1);
  });

  test("keeps layout history isolated per saved layout", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const defaultRatio = initial.config.layout.dockRoot && initial.config.layout.dockRoot.kind === "split"
      ? initial.config.layout.dockRoot.ratio
      : null;
    const newLayoutIndex = initial.config.layouts.length;

    const firstLayout = cloneLayout(initial.config.layout);
    if (!firstLayout.dockRoot || firstLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    firstLayout.dockRoot.ratio = 0.45;
    let state = appReducer(initial, { type: "PUSH_LAYOUT_HISTORY" });
    state = appReducer(state, { type: "UPDATE_LAYOUT", layout: firstLayout });
    state = appReducer(state, { type: "NEW_LAYOUT", name: "Research" });

    const noUndoOnFreshLayout = appReducer(state, { type: "UNDO_LAYOUT" });
    expect(noUndoOnFreshLayout.config.activeLayoutIndex).toBe(newLayoutIndex);
    expect(noUndoOnFreshLayout.config.layout).toEqual(createBlankLayout());
    expect(noUndoOnFreshLayout.focusedPaneId).toBeNull();

    const secondLayout = cloneLayout(initial.config.layout);
    if (!secondLayout.dockRoot || secondLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    secondLayout.dockRoot.ratio = 0.55;
    state = appReducer(noUndoOnFreshLayout, { type: "PUSH_LAYOUT_HISTORY" });
    state = appReducer(state, { type: "UPDATE_LAYOUT", layout: secondLayout });

    const backToFirst = appReducer(state, { type: "SWITCH_LAYOUT", index: 0 });
    const firstUndone = appReducer(backToFirst, { type: "UNDO_LAYOUT" });
    expect(firstUndone.config.activeLayoutIndex).toBe(0);
    expect(firstUndone.config.layout.dockRoot && firstUndone.config.layout.dockRoot.kind === "split"
      ? firstUndone.config.layout.dockRoot.ratio
      : null).toBe(defaultRatio);

    const backToSecond = appReducer(firstUndone, { type: "SWITCH_LAYOUT", index: newLayoutIndex });
    const secondUndone = appReducer(backToSecond, { type: "UNDO_LAYOUT" });
    expect(secondUndone.config.activeLayoutIndex).toBe(newLayoutIndex);
    expect(secondUndone.config.layout).toEqual(createBlankLayout());
  });
});

describe("saved layouts", () => {
  test("reorders saved layouts without changing the active workspace", () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-reorder-test");
    const baseLayout = cloneLayout(config.layout);
    config.layouts = [
      { name: "Home", layout: cloneLayout(baseLayout) },
      { name: "Research", layout: cloneLayout(baseLayout) },
      { name: "News", layout: cloneLayout(baseLayout) },
    ];
    config.activeLayoutIndex = 1;
    config.layout = cloneLayout(config.layouts[1]!.layout);

    const historyLayout = (ratio: number) => {
      const layout = cloneLayout(baseLayout);
      if (!layout.dockRoot || layout.dockRoot.kind !== "split") {
        throw new Error("expected split dock root");
      }
      layout.dockRoot.ratio = ratio;
      return layout;
    };

    const state = {
      ...createInitialState(config),
      paneState: {
        "ticker-detail:main": { activeTabId: "financials" },
      },
      focusedPaneId: "ticker-detail:main",
      layoutHistory: {
        0: { past: [historyLayout(0.41)], future: [] },
        1: { past: [historyLayout(0.52)], future: [] },
        2: { past: [historyLayout(0.63)], future: [] },
      },
    };

    const next = appReducer(state, { type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });

    expect(next.config.layouts.map((layout) => layout.name)).toEqual(["Research", "News", "Home"]);
    expect(next.config.activeLayoutIndex).toBe(0);
    expect(next.config.layout).toEqual(state.config.layout);
    expect(next.paneState).toEqual(state.paneState);
    expect(next.config.layouts[0]?.paneState?.["ticker-detail:main"]?.activeTabId).toBe("financials");
    expect(next.layoutHistory[0]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.52 });
    expect(next.layoutHistory[1]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.63 });
    expect(next.layoutHistory[2]?.past[0]?.dockRoot).toMatchObject({ kind: "split", ratio: 0.41 });
  });

  test("keeps saved layout operations coherent after a reorder", () => {
    const config = createDefaultConfig("/tmp/gloomberb-layout-operations-test");
    const baseLayout = cloneLayout(config.layout);
    config.layouts = [
      { name: "Home", layout: cloneLayout(baseLayout) },
      { name: "Research", layout: cloneLayout(baseLayout) },
      { name: "News", layout: cloneLayout(baseLayout) },
    ];
    config.activeLayoutIndex = 1;
    config.layout = cloneLayout(config.layouts[1]!.layout);

    let state = createInitialState(config);
    state = appReducer(state, { type: "REORDER_LAYOUT", fromIndex: 0, toIndex: 2 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual(["Research", "News", "Home"]);
    expect(state.config.activeLayoutIndex).toBe(0);

    state = appReducer(state, { type: "RENAME_LAYOUT", index: 0, name: "Overview" });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual(["Overview", "News", "Home"]);

    state = appReducer(state, { type: "DUPLICATE_LAYOUT", index: 0 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "News",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(3);

    state = appReducer(state, { type: "SWITCH_LAYOUT", index: 1 });
    expect(state.config.activeLayoutIndex).toBe(1);
    expect(state.config.layouts[state.config.activeLayoutIndex]?.name).toBe("News");

    state = appReducer(state, { type: "NEW_LAYOUT", name: "Scratch" });
    expect(state.config.layouts.at(-1)?.name).toBe("Scratch");
    expect(state.config.activeLayoutIndex).toBe(4);
    expect(state.config.layout).toEqual(createBlankLayout());

    state = appReducer(state, { type: "DELETE_LAYOUT", index: 4 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "News",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(3);

    state = appReducer(state, { type: "DELETE_LAYOUT", index: 1 });
    expect(state.config.layouts.map((layout) => layout.name)).toEqual([
      "Overview",
      "Home",
      "Overview Copy",
    ]);
    expect(state.config.activeLayoutIndex).toBe(2);
    expect(state.config.layouts[state.config.activeLayoutIndex]?.name).toBe("Overview Copy");
  });

  test("installs marketplace layouts as independent editable copies", () => {
    const config = createDefaultConfig("/tmp/gloomberb-marketplace-install-test");
    config.layouts.push(
      { name: "Research", layout: cloneLayout(config.layout) },
      { name: "Research (2)", layout: cloneLayout(config.layout) },
    );
    const marketplaceLayout = cloneLayout(config.layout);
    if (!marketplaceLayout.dockRoot || marketplaceLayout.dockRoot.kind !== "split") {
      throw new Error("expected split dock root");
    }
    marketplaceLayout.dockRoot.ratio = 0.72;

    const installed = appReducer(createInitialState(config), {
      type: "INSTALL_LAYOUT_COPY",
      name: "Research",
      layout: marketplaceLayout,
      paneState: {
        "ticker-detail:main": {
          pluginState: { "prediction-markets": { searchQuery: "fed" } },
        },
      },
    });

    expect(installed.config.layouts.at(-1)?.name).toBe("Research (3)");
    expect(installed.config.activeLayoutIndex).toBe(installed.config.layouts.length - 1);
    expect(installed.config.layout.dockRoot).toMatchObject({ kind: "split", ratio: 0.72 });
    expect(installed.paneState["ticker-detail:main"]).toMatchObject({
      pluginState: { "prediction-markets": { searchQuery: "fed" } },
    });

    marketplaceLayout.dockRoot.ratio = 0.2;
    expect(installed.config.layout.dockRoot).toMatchObject({ kind: "split", ratio: 0.72 });
  });

  test("links, replaces, and unlinks a tab that follows a team layout", () => {
    const config = createDefaultConfig("/tmp/gloomberb-linked-layout-test");
    const origin = {
      kind: "team" as const,
      teamId: "org-1",
      layoutId: "a".repeat(32),
      revision: 1,
      contentHash: "1-deadbeef",
      syncedAt: "2026-09-14T12:00:00.000Z",
    };
    let state = appReducer(createInitialState(config), {
      type: "INSTALL_LAYOUT_COPY",
      name: "Morning",
      layout: cloneLayout(config.layout),
      paneState: {},
      origin,
    });
    const index = state.config.layouts.length - 1;
    expect(state.config.layouts[index]?.origin).toEqual(origin);
    expect(state.config.activeLayoutIndex).toBe(index);

    // A pulled revision replaces content and bumps the origin, even for the active tab.
    const pulled = cloneLayout(config.layout);
    if (!pulled.dockRoot || pulled.dockRoot.kind !== "split") throw new Error("expected split dock root");
    pulled.dockRoot.ratio = 0.31;
    state = appReducer(state, {
      type: "REPLACE_LAYOUT_CONTENT",
      index,
      layout: pulled,
      paneState: { "ticker-detail:main": { activeTabId: "news" } },
      origin: { ...origin, revision: 2, contentHash: "1-cafebabe" },
      name: "Morning v2",
    });
    expect(state.config.layouts[index]).toMatchObject({ name: "Morning v2", origin: { revision: 2 } });
    expect(state.config.layout.dockRoot).toMatchObject({ ratio: 0.31 });
    expect(state.paneState["ticker-detail:main"]).toEqual({ activeTabId: "news" });
    expect(state.layoutHistory[index]).toEqual({ past: [], future: [] });

    // Replacing an inactive tab leaves the live layout alone.
    state = appReducer(state, { type: "SWITCH_LAYOUT", index: 0 });
    state = appReducer(state, {
      type: "REPLACE_LAYOUT_CONTENT",
      index,
      layout: cloneLayout(config.layout),
      paneState: {},
      origin: { ...origin, revision: 3, contentHash: "x" },
    });
    expect(state.config.layouts[index]?.origin?.revision).toBe(3);
    expect(state.config.activeLayoutIndex).toBe(0);

    state = appReducer(state, { type: "SET_LAYOUT_ORIGIN", index, origin: null });
    expect(state.config.layouts[index]?.origin).toBeUndefined();
    expect(state.config.layouts[index]?.name).toBe("Morning v2");
    expect(appReducer(state, { type: "SET_LAYOUT_ORIGIN", index: 99, origin })).toBe(state);
  });
});

describe("focus restore", () => {
  test("restores an explicit focus target after a layout removes the focused pane", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test-focus-restore");
    const nextLayout = removePane(config.layout, "ticker-detail:main");
    const state = {
      ...createInitialState(config),
      focusedPaneId: "ticker-detail:main",
      previousFocusedPaneId: "portfolio-list:main",
    };

    const next = appReducer(state, {
      type: "UPDATE_LAYOUT",
      layout: nextLayout,
      focusedPaneId: "portfolio-list:main",
    });

    expect(next.focusedPaneId).toBe("portfolio-list:main");
    expect(next.config.layouts[next.config.activeLayoutIndex]?.focusedPaneId).toBe("portfolio-list:main");
  });

  test("preserves the restore source while activating a pane in another panel", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test-focus-activation");
    let state = {
      ...createInitialState(config),
      focusedPaneId: "portfolio-list:main",
      previousFocusedPaneId: null,
      activePanel: "left" as const,
    };

    state = appReducer(state, { type: "SET_ACTIVE_PANEL", panel: "right", preserveFocus: true });
    expect(state.activePanel).toBe("right");
    expect(state.focusedPaneId).toBe("portfolio-list:main");
    expect(state.previousFocusedPaneId).toBeNull();

    state = appReducer(state, { type: "FOCUS_PANE", paneId: "ticker-detail:main" });
    expect(state.focusedPaneId).toBe("ticker-detail:main");
    expect(state.previousFocusedPaneId).toBe("portfolio-list:main");

    const restored = appReducer(state, {
      type: "UPDATE_LAYOUT",
      layout: removePane(state.config.layout, "ticker-detail:main"),
      focusedPaneId: state.previousFocusedPaneId,
    });

    expect(restored.focusedPaneId).toBe("portfolio-list:main");
  });
});

describe("update checks", () => {
  test("tracks manual update-check feedback", () => {
    const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    const checking = appReducer(initial, { type: "SET_UPDATE_CHECK_IN_PROGRESS", checking: true });
    const noticed = appReducer(checking, { type: "SET_UPDATE_NOTICE", notice: "Already on v0.3.1" });

    expect(checking.updateCheckInProgress).toBe(true);
    expect(noticed.updateNotice).toBe("Already on v0.3.1");
  });

  test("clears stale update notices when an update becomes available", () => {
    const initial = {
      ...createInitialState(createDefaultConfig("/tmp/gloomberb-test")),
      updateNotice: "Already on v0.3.1",
    };
    const next = appReducer(initial, {
      type: "SET_UPDATE_AVAILABLE",
      release: {
        version: "0.3.2",
        tagName: "v0.3.2",
        downloadUrl: "https://example.com/gloomberb.gz",
        publishedAt: "2026-04-03T00:00:00Z",
        updateAction: { kind: "self" },
        compressed: true,
      },
    });

    expect(next.updateAvailable?.version).toBe("0.3.2");
    expect(next.updateNotice).toBeNull();
  });
});
