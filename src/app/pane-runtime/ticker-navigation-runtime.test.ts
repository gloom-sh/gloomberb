import { expect, test } from "bun:test";
import { createInitialState } from "../../state/app/context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createTestTicker } from "../../test-support/ticker";
import { createDefaultConfig, type LayoutConfig, type PaneBinding } from "../../types/config";
import type { BrokerContractRef } from "../../types/instrument";
import type { TickerOpenTarget } from "../../tickers/open-target";
import { bindAppPanePluginRegistry } from "./plugin-bindings";

async function settle() {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
}

function target(symbol: string, instrument?: BrokerContractRef | null): TickerOpenTarget {
  return { symbol, ticker: createTestTicker(symbol), created: false,
    ...(instrument !== undefined ? { instrument } : {}),
    listing: { name: symbol, exchange: "NASDAQ", currency: "USD", type: instrument?.secType ?? "EQUITY" },
  };
}

function runtime() {
  const state = createInitialState(createDefaultConfig(":memory:"));
  state.config.layout = {
    dockRoot: { kind: "split", axis: "horizontal", ratio: 0.5,
      first: { kind: "pane", instanceId: "first" }, second: { kind: "pane", instanceId: "second" } },
    instances: ["first", "second"].map(instanceId => ({ instanceId, paneId: "ticker-research",
      binding: { kind: "fixed", symbol: "INITIAL", instrument: null } })),
    floating: [], detached: [],
  };
  state.focusedPaneId = "first";
  const stateRef = { current: state };
  const published: TickerOpenTarget[] = [];
  const focused: string[] = [];
  const placed: TickerOpenTarget[] = [];
  const notifications: unknown[] = [];
  const requests = new Map<string, PromiseWithResolvers<TickerOpenTarget | null>>();
  const feedbackOwners = new Map<string, (() => boolean) | undefined>();
  const registry = { panes: new Map(), getTermSizeFn: () => ({ width: 120, height: 40 }),
    notify: (message: unknown) => notifications.push(message) } as any;
  const persistLayout = (layout: LayoutConfig) => {
    stateRef.current = { ...stateRef.current, config: { ...stateRef.current.config, layout } };
  };
  const rebind = () => bindAppPanePluginRegistry({
    activatePane: (id) => { focused.push(id); stateRef.current = { ...stateRef.current, focusedPaneId: id }; },
    buildPaneInstance: () => null,
    createPaneFromTemplate: async () => {}, dataProvider: createTestDataProvider(), detachedPaneId: null,
    dispatch() {}, externalPlugins: [], focusVisiblePane() {}, isDetachedWindow: false,
    openPaneSettings: async () => {}, openPinnedTicker: async () => {}, persistConfig() {}, persistLayout,
    placePaneInstance() {}, placePinnedTickerTarget: (value) => placed.push(value), pluginRegistry: registry,
    publishTickerOpenTarget: (value) => published.push(value),
    resolveOpenTickerTarget: (symbol, _publicOnly, canPresentFeedback) => {
      feedbackOwners.set(symbol, canPresentFeedback);
      const request = Promise.withResolvers<TickerOpenTarget | null>(); requests.set(symbol, request); return request.promise;
    },
    resolvePaneTarget: () => null, selectTickerInPane() {}, showPane() {}, state: stateRef.current, stateRef,
    switchTickerResearchTab() {}, tickerRepository: {} as any,
  });
  rebind();
  return { stateRef, registry, requests, feedbackOwners, published, focused, placed, notifications, rebind, persistLayout,
    binding: (id = "first") => stateRef.current.config.layout.instances.find(pane => pane.instanceId === id)!.binding,
  };
}

const future: BrokerContractRef = { brokerId: "ibkr", brokerInstanceId: "retirement", conId: 123,
  symbol: "ES", localSymbol: "ESZ6", secType: "FUT", currency: "USD", exchange: "CME" };

test("replacement preserves an explicit public selection or broker contract instead of ticker fallback", async () => {
  for (const instrument of [null, future]) {
    const app = runtime();
    const selected = target("ES", instrument);
    // The record's default is intentionally a competing instrument.
    selected.ticker.metadata.broker_contracts = [{ ...future, brokerInstanceId: "taxable", conId: 456 }];
    app.registry.navigateTickerFn("ES", { sourcePaneId: "first" });
    app.requests.get("ES")!.resolve(selected);
    await settle();
    expect(app.binding()).toEqual({ kind: "fixed", symbol: "ES", instrument, listing: selected.listing });
    expect(app.published).toEqual([selected]);
    expect(app.focused).toEqual(["first"]);
  }
});

test("a newer navigation owns the pane across registry rebinding and stale failure cannot notify", async () => {
  for (const staleFails of [false, true]) {
    const app = runtime();
    app.registry.navigateTickerFn("OLD", { sourcePaneId: "first" });
    app.rebind();
    app.registry.navigateTickerFn("NEW", { sourcePaneId: "first" });
    expect(app.feedbackOwners.get("OLD")?.()).toBe(false);
    expect(app.feedbackOwners.get("NEW")?.()).toBe(true);
    const selected = target("NEW", null);
    app.requests.get("NEW")!.resolve(selected);
    await settle();
    if (staleFails) app.requests.get("OLD")!.reject(new Error("obsolete request failure"));
    else app.requests.get("OLD")!.resolve(target("OLD", future));
    await settle();
    expect(app.binding()).toMatchObject({ symbol: "NEW", instrument: null });
    expect(app.published).toEqual([selected]);
    expect(app.focused).toEqual(["first"]);
    expect(app.notifications).toEqual([]);
  }
});

test("independent pane navigation completes without reclaiming focus from the other pane", async () => {
  const app = runtime();
  app.registry.navigateTickerFn("LEFT", { sourcePaneId: "first" });
  app.stateRef.current = { ...app.stateRef.current, focusedPaneId: "second" };
  app.rebind();
  app.registry.navigateTickerFn("RIGHT", { sourcePaneId: "second" });
  expect(app.feedbackOwners.get("LEFT")?.()).toBe(false);
  expect(app.feedbackOwners.get("RIGHT")?.()).toBe(true);
  app.requests.get("RIGHT")!.resolve(target("RIGHT", future));
  await settle();
  app.requests.get("LEFT")!.resolve(target("LEFT", null));
  await settle();
  expect(app.binding("first")).toMatchObject({ symbol: "LEFT", instrument: null });
  expect(app.binding("second")).toMatchObject({ symbol: "RIGHT", instrument: future });
  expect(app.published.map(value => value.symbol)).toEqual(["RIGHT", "LEFT"]);
  expect(app.focused).toEqual(["second"]);
});

test("a pending result cannot overwrite an intervening direct selection or reopen a closed destination", async () => {
  for (const close of [false, true]) {
    const app = runtime();
    app.registry.navigateTickerFn("SLOW", { sourcePaneId: "first" });
    const layout = app.stateRef.current.config.layout;
    const replacement: PaneBinding = { kind: "fixed", symbol: "DIRECT", instrument: future };
    app.persistLayout({ ...layout, instances: close ? layout.instances.filter(pane => pane.instanceId !== "first")
      : layout.instances.map(pane => pane.instanceId === "first" ? { ...pane, binding: replacement } : pane) });
    expect(app.feedbackOwners.get("SLOW")?.()).toBe(false);
    app.requests.get("SLOW")!.resolve(target("SLOW", null));
    await settle();
    expect(app.published).toEqual([]);
    expect(app.focused).toEqual([]);
    expect(app.placed).toEqual([]);
    if (!close) expect(app.binding()).toEqual(replacement);
  }
});
