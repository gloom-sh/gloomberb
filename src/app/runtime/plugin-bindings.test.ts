import { afterEach, expect, test } from "bun:test";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import type { MarketDataCoordinator } from "../../market-data/coordinator";
import type { PluginRegistry } from "../../plugins/registry";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createTestTicker } from "../../test-support/ticker";
import type { TickerRecord } from "../../types/ticker";
import { createTestBrokerAdapter } from "../../test-support/broker";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import { bindPluginRegistryRuntimeAccess } from "./plugin-bindings";

afterEach(() => {
  setConfigStoreHost(null);
});

// On the desktop an adapter's disconnect is a call to the Bun process, which
// throws before returning a promise when that host is missing; the `.catch`
// on its result never saw it, and the profile stayed.
test("a profile goes even when its adapter's disconnect throws", async () => {
  const saved: AppConfig[] = [];
  setConfigStoreHost({ saveConfig: async (config: AppConfig) => { saved.push(config); } } as unknown as ConfigStoreHost);
  const instance: BrokerInstanceConfig = { id: "demo-live", brokerType: "demo", label: "Demo", config: {} };
  const stateRef: { current: AppState } = {
    current: createInitialState({ ...createDefaultConfig("/tmp/gloomberb-remove-broker-test"), brokerInstances: [instance] }),
  };
  const pluginRegistry = {
    brokers: new Map([["demo", createTestBrokerAdapter({
      disconnect: () => { throw new Error("Broker remote host is not available."); },
    })]]),
    persistence: { resources: { list: () => [], delete: () => {} } },
    events: { emit() {} },
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
  bindPluginRegistryRuntimeAccess({
    dataProvider: {} as DataProvider,
    dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
    importBrokerPositions: async () => {},
    marketData: {} as MarketDataCoordinator,
    pluginRegistry,
    stateRef,
    tickerRepository: {} as never,
  });

  await pluginRegistry.removeBrokerInstance("demo-live");

  expect(stateRef.current.config.brokerInstances).toEqual([]);
  expect(saved.at(-1)?.brokerInstances).toEqual([]);
});

test.each(["save", "delete"])("profile removal keeps edits made during its first %s", async (firstWrite) => {
  setConfigStoreHost({ saveConfig: async () => {} } as unknown as ConfigStoreHost);
  const instance: BrokerInstanceConfig = { id: "demo-live", brokerType: "demo", label: "Demo", config: {} };
  const config = createDefaultConfig("unused");
  const portfolio = { id: "broker:demo-live:ACC", name: "Account", currency: "USD", brokerId: "demo", brokerInstanceId: instance.id, brokerAccountId: "ACC" };
  const stateRef = { current: createInitialState({ ...config, brokerInstances: [instance], portfolios: [...config.portfolios, portfolio] }) };
  stateRef.current.tickers = new Map(["AAA", "BBB", "CCC", "DDD"].map((symbol) => [symbol, createTestTicker(symbol, symbol, {
    portfolios: [portfolio.id],
    positions: [{ portfolio: portfolio.id, shares: 3, broker: "demo", brokerInstanceId: instance.id }],
    watchlists: symbol === "BBB" || (symbol === "AAA" && firstWrite === "save") ? ["watchlist"] : [],
  })]));
  const disk = new Map(stateRef.current.tickers);
  const edited = createTestTicker("BBB", "Edited", { portfolios: ["main"], positions: [{ portfolio: "main", broker: "manual", shares: 9 }] });
  const recreated = createTestTicker("CCC", "Recreated", { watchlists: ["watchlist"] });
  const added = createTestTicker("NEW", "Added", { watchlists: ["watchlist"] });
  const newPortfolio = { id: "new", name: "New", currency: "USD" };
  let editedDuringWrite = false;
  const editDuringWrite = () => {
    if (editedDuringWrite) return;
    editedDuringWrite = true;
    const tickers = new Map(stateRef.current.tickers);
    for (const ticker of [edited, recreated, added]) {
      tickers.set(ticker.metadata.ticker, ticker);
      disk.set(ticker.metadata.ticker, ticker);
    }
    stateRef.current = { ...stateRef.current, tickers, config: {
      ...stateRef.current.config,
      portfolios: [...stateRef.current.config.portfolios, newPortfolio],
    } };
  };
  const pluginRegistry = {
    brokers: new Map([["demo", createTestBrokerAdapter()]]),
    persistence: { resources: { list: () => [], delete: () => {} } },
    events: { emit() {} },
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
  bindPluginRegistryRuntimeAccess({
    dataProvider: {} as DataProvider,
    dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
    importBrokerPositions: async () => {},
    marketData: {} as MarketDataCoordinator,
    pluginRegistry,
    stateRef,
    tickerRepository: {
      saveTicker: async (ticker: TickerRecord) => { disk.set(ticker.metadata.ticker, ticker); editDuringWrite(); },
      deleteTicker: async (symbol: string) => { disk.delete(symbol); editDuringWrite(); },
    } as never,
  });

  await pluginRegistry.removeBrokerInstance(instance.id);

  for (const ticker of [edited, recreated, added]) {
    expect(stateRef.current.tickers.get(ticker.metadata.ticker)).toBe(ticker);
    expect(disk.get(ticker.metadata.ticker)).toBe(ticker);
  }
  expect(stateRef.current.tickers.has("DDD")).toBe(false);
  expect(disk.has("DDD")).toBe(false);
  expect(stateRef.current.config.brokerInstances).toEqual([]);
  expect(stateRef.current.config.portfolios).toEqual([...config.portfolios, newPortfolio]);
});

test("profile removal persists config edits from a synchronous removal listener", async () => {
  const saved: AppConfig[] = [];
  setConfigStoreHost({ saveConfig: async (config: AppConfig) => { saved.push(config); } } as unknown as ConfigStoreHost);
  const instance: BrokerInstanceConfig = { id: "demo-live", brokerType: "demo", label: "Demo", config: {} };
  const config = createDefaultConfig("unused");
  const portfolio = { id: "broker:demo-live:ACC", name: "Account", currency: "USD", brokerId: "demo", brokerInstanceId: instance.id, brokerAccountId: "ACC" };
  const stateRef = { current: createInitialState({ ...config, brokerInstances: [instance], portfolios: [...config.portfolios, portfolio] }) };
  stateRef.current.tickers.set("AAA", createTestTicker("AAA", "AAA", {
    portfolios: [portfolio.id],
    positions: [{ portfolio: portfolio.id, shares: 3, broker: "demo", brokerInstanceId: instance.id }],
  }));
  let listenerSave: Promise<void> | undefined;
  const pluginRegistry = {
    brokers: new Map([["demo", createTestBrokerAdapter()]]),
    persistence: { resources: { list: () => [], delete: () => {} } },
    events: { emit(event: string, payload: { symbol?: string }) {
      if (event === "ticker:removed") {
        listenerSave = pluginRegistry.setPluginConfigValue("example", "lastRemoved", payload.symbol);
      }
    } },
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
  bindPluginRegistryRuntimeAccess({
    dataProvider: {} as DataProvider,
    dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
    importBrokerPositions: async () => {},
    marketData: {} as MarketDataCoordinator,
    pluginRegistry,
    stateRef,
    tickerRepository: { deleteTicker: async () => {} } as never,
  });

  await pluginRegistry.removeBrokerInstance(instance.id);
  await listenerSave;

  expect(stateRef.current.config.pluginConfig.example).toEqual({ lastRemoved: "AAA" });
  expect(saved.at(-1)?.pluginConfig.example).toEqual({ lastRemoved: "AAA" });
  expect(saved.at(-1)?.brokerInstances).toEqual([]);
});
