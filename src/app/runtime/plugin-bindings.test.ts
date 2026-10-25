import { afterEach, expect, test } from "bun:test";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import { runTickerWrite } from "../../data/ticker-writes";
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function removalHarness() {
  const instance: BrokerInstanceConfig = { id: "demo-live", brokerType: "demo", label: "Demo", config: {} };
  const config = createDefaultConfig("unused");
  const portfolio = { id: "broker:demo-live:ACC", name: "Account", currency: "USD", brokerId: "demo", brokerInstanceId: instance.id, brokerAccountId: "ACC" };
  const stateRef = { current: createInitialState({ ...config, brokerInstances: [instance], portfolios: [...config.portfolios, portfolio] }) };
  stateRef.current.tickers = new Map(["AAA", "BBB"].map((symbol) => [symbol, createTestTicker(symbol, symbol, {
    portfolios: symbol === "AAA" ? [portfolio.id, "main"] : [portfolio.id],
    positions: [
      { portfolio: portfolio.id, shares: 3, broker: "demo", brokerInstanceId: instance.id },
      ...(symbol === "AAA" ? [{ portfolio: "main", shares: 1, broker: "manual" }] : []),
    ],
  })]));
  const disk = new Map([...stateRef.current.tickers].map(([symbol, ticker]) => [symbol, structuredClone(ticker)]));
  const savedConfigs: AppConfig[] = [structuredClone(stateRef.current.config)];
  const writes: {
    beforeSave?: (ticker: TickerRecord) => void | Promise<void>;
    afterSave?: (ticker: TickerRecord) => void | Promise<void>;
    beforeDelete?: (symbol: string) => void | Promise<void>;
    beforeConfigSave?: () => void | Promise<void>;
    afterConfigSave?: () => void | Promise<void>;
  } = {};
  setConfigStoreHost({ saveConfig: async (next: AppConfig) => {
    await writes.beforeConfigSave?.();
    savedConfigs.push(structuredClone(next));
    await writes.afterConfigSave?.();
  } } as unknown as ConfigStoreHost);
  // Desktop callers publish their edit only after this exact persistence promise
  // resolves. The repository must remain the same object for every operation.
  const repository = {
    saveTicker(ticker: TickerRecord): Promise<void> {
      return runTickerWrite(repository, ticker.metadata.ticker, async () => {
        await writes.beforeSave?.(ticker);
        disk.set(ticker.metadata.ticker, structuredClone(ticker));
        await writes.afterSave?.(ticker);
      });
    },
    deleteTicker(symbol: string): Promise<void> {
      return runTickerWrite(repository, symbol, async () => {
        await writes.beforeDelete?.(symbol);
        disk.delete(symbol);
      });
    },
    async loadTicker(symbol: string): Promise<TickerRecord | null> {
      return structuredClone(disk.get(symbol) ?? null);
    },
    async loadAllTickers(): Promise<TickerRecord[]> {
      return [...disk.values()].map((ticker) => structuredClone(ticker));
    },
  };
  const disconnected = deferred();
  const pluginRegistry = {
    brokers: new Map([["demo", createTestBrokerAdapter({ disconnect: async () => { disconnected.resolve(); } })]]),
    persistence: { resources: { list: () => [], delete: () => {} } },
    events: { emit() {} },
    bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
  } as unknown as PluginRegistry;
  const dispatch = (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); };
  bindPluginRegistryRuntimeAccess({
    dataProvider: {} as DataProvider,
    dispatch,
    importBrokerPositions: async () => {},
    marketData: {} as MarketDataCoordinator,
    pluginRegistry,
    stateRef,
    tickerRepository: repository as never,
  });
  const saveEdit = (ticker: TickerRecord) => repository.saveTicker(ticker).then(() => dispatch({ type: "UPDATE_TICKER", ticker }));
  const manualEdit = (): TickerRecord => {
    const ticker = stateRef.current.tickers.get("AAA")!;
    return { ...ticker, metadata: { ...ticker.metadata, positions: [
      ...ticker.metadata.positions.filter((position) => position.broker !== "manual"),
      { portfolio: "main", shares: 9, broker: "manual" },
    ] } };
  };
  return { instance, portfolio, stateRef, savedConfigs, repository, writes, disconnected, pluginRegistry, saveEdit, manualEdit };
}

test("profile removal retains a manual edit whose desktop save is still awaiting acknowledgement", async () => {
  const harness = removalHarness();
  const written = deferred();
  const acknowledgement = deferred();
  let held = false;
  harness.writes.afterSave = async () => {
    if (held) return;
    held = true;
    written.resolve();
    await acknowledgement.promise;
  };
  const edit = harness.saveEdit(harness.manualEdit());
  await written.promise;
  expect(harness.stateRef.current.tickers.get("AAA")?.metadata.positions.at(-1)?.shares).toBe(1);

  const removal = harness.pluginRegistry.removeBrokerInstance(harness.instance.id);
  await harness.disconnected.promise;
  // Let cleanup reach the pending write while the edit is absent from app state.
  await Bun.sleep(0);
  acknowledgement.resolve();
  await Promise.all([edit, removal]);

  const positions = [{ portfolio: "main", shares: 9, broker: "manual" }];
  expect({
    state: harness.stateRef.current.tickers.get("AAA")?.metadata.positions,
    reloaded: (await harness.repository.loadTicker("AAA"))?.metadata.positions,
  }).toEqual({ state: positions, reloaded: positions });
  expect(await harness.repository.loadTicker("BBB")).toBeNull();
  expect(harness.stateRef.current.config.brokerInstances).toEqual([]);
  expect(harness.savedConfigs.at(-1)?.brokerInstances).toEqual([]);
});

test("profile removal rechecks a manual edit started during its save acknowledgement", async () => {
  const harness = removalHarness();
  const edited = harness.manualEdit();
  const written = deferred();
  const acknowledgement = deferred();
  let held = false;
  harness.writes.afterSave = async () => {
    if (held) return;
    held = true;
    written.resolve();
    await acknowledgement.promise;
  };
  const removal = harness.pluginRegistry.removeBrokerInstance(harness.instance.id);
  await written.promise;
  // The form began with the original row. Its write is requested while cleanup's
  // save is still awaiting the desktop response, before either caller publishes.
  const edit = harness.saveEdit(edited);
  acknowledgement.resolve();
  await Promise.all([edit, removal]);

  const positions = [{ portfolio: "main", shares: 9, broker: "manual" }];
  expect({
    state: harness.stateRef.current.tickers.get("AAA")?.metadata.positions,
    reloaded: (await harness.repository.loadTicker("AAA"))?.metadata.positions,
  }).toEqual({ state: positions, reloaded: positions });
  expect(await harness.repository.loadTicker("BBB")).toBeNull();
});

test.each(["existing", "new"])("profile removal rechecks the %s row saved during the final config acknowledgement", async (row) => {
  const harness = removalHarness();
  const original = harness.manualEdit();
  const edited = row === "existing" ? original : {
    ...original, metadata: { ...original.metadata, ticker: "NEW" },
  };
  const configWritten = deferred();
  const configAcknowledgement = deferred();
  let heldConfig = false;
  harness.writes.afterConfigSave = async () => {
    if (heldConfig) return;
    heldConfig = true;
    configWritten.resolve();
    await configAcknowledgement.promise;
  };
  const removal = harness.pluginRegistry.removeBrokerInstance(harness.instance.id);
  await configWritten.promise;

  const rowWritten = deferred();
  const rowAcknowledgement = deferred();
  let heldRow = false;
  if (row === "new") harness.writes.afterSave = async () => {
    if (heldRow) return;
    heldRow = true;
    rowWritten.resolve();
    await rowAcknowledgement.promise;
  };
  const edit = harness.saveEdit(edited);
  // One edit is already published when config responds; the other still only
  // exists in persistence, so an unchanged ticker map cannot prove cleanup ended.
  if (row === "existing") await edit;
  else await rowWritten.promise;
  configAcknowledgement.resolve();
  if (row === "new") {
    await Bun.sleep(0);
    rowAcknowledgement.resolve();
  }
  await Promise.all([edit, removal]);

  const symbol = edited.metadata.ticker;
  const positions = [{ portfolio: "main", shares: 9, broker: "manual" }];
  expect({
    state: harness.stateRef.current.tickers.get(symbol)?.metadata.positions,
    reloaded: (await harness.repository.loadTicker(symbol))?.metadata.positions,
  }).toEqual({ state: positions, reloaded: positions });
  expect(await harness.repository.loadTicker("BBB")).toBeNull();
  expect(harness.stateRef.current.config.brokerInstances).toEqual([]);
  expect(harness.savedConfigs.at(-1)?.brokerInstances).toEqual([]);
});

test.each(["save", "delete"])("profile removal can retry a late %s failure after the final config acknowledgement", async (operation) => {
  const harness = removalHarness();
  const edited = harness.manualEdit();
  const added = createTestTicker("NEW", "Added", {
    portfolios: [harness.portfolio.id],
    positions: [{ portfolio: harness.portfolio.id, shares: 2, broker: "demo", brokerInstanceId: harness.instance.id }],
  });
  const configWritten = deferred();
  const configAcknowledgement = deferred();
  let heldConfig = false;
  harness.writes.afterConfigSave = async () => {
    if (heldConfig) return;
    heldConfig = true;
    configWritten.resolve();
    await configAcknowledgement.promise;
  };
  const removal = harness.pluginRegistry.removeBrokerInstance(harness.instance.id);
  await configWritten.promise;
  await harness.saveEdit(edited);
  if (operation === "delete") await harness.saveEdit(added);
  const failure = new Error(`Late ticker ${operation} failed`);
  let fail = true;
  if (operation === "save") harness.writes.beforeSave = () => { if (fail) throw failure; };
  else harness.writes.beforeDelete = () => { if (fail) throw failure; };
  configAcknowledgement.resolve();
  const outcome = await removal.then(() => null, (error: unknown) => error);
  expect(outcome).toBe(failure);
  expect(harness.stateRef.current.config.brokerInstances).toEqual([harness.instance]);
  const savedConfig = harness.savedConfigs.at(-1)!;
  expect(savedConfig.brokerInstances).toEqual([harness.instance]);
  harness.stateRef.current = {
    ...createInitialState(savedConfig),
    tickers: new Map((await harness.repository.loadAllTickers()).map((ticker) => [ticker.metadata.ticker, ticker])),
  };

  fail = false;
  await harness.pluginRegistry.removeBrokerInstance(harness.instance.id);

  const reloaded = await harness.repository.loadAllTickers();
  expect(reloaded.map((ticker) => ticker.metadata.ticker)).toEqual(["AAA"]);
  expect(reloaded[0]?.metadata.positions).toEqual([{ portfolio: "main", shares: 9, broker: "manual" }]);
  expect(harness.stateRef.current.tickers.get("AAA")?.metadata.positions).toEqual(reloaded[0]?.metadata.positions);
  expect(harness.stateRef.current.config.brokerInstances).toEqual([]);
  expect(harness.savedConfigs.at(-1)?.brokerInstances).toEqual([]);
});

test.each(["save", "delete", "config save"])("profile removal retries after a failed %s without losing a subsequent manual edit", async (operation) => {
  const harness = removalHarness();
  const failure = new Error(`Could not ${operation} ticker`);
  let fail = true;
  if (operation === "save") harness.writes.beforeSave = () => { if (fail) throw failure; };
  else if (operation === "delete") harness.writes.beforeDelete = () => { if (fail) throw failure; };
  else harness.writes.beforeConfigSave = () => { if (fail) throw failure; };

  await expect(harness.pluginRegistry.removeBrokerInstance(harness.instance.id)).rejects.toThrow(failure.message);
  const profilesAfterFailure = harness.stateRef.current.config.brokerInstances;
  const savedProfilesAfterFailure = harness.savedConfigs.at(-1)?.brokerInstances;

  fail = false;
  await harness.saveEdit(harness.manualEdit());
  await harness.pluginRegistry.removeBrokerInstance(harness.instance.id);

  const reloaded = await harness.repository.loadAllTickers();
  expect(reloaded.map((ticker) => ticker.metadata.ticker)).toEqual(["AAA"]);
  expect(reloaded[0]?.metadata.positions).toEqual([{ portfolio: "main", shares: 9, broker: "manual" }]);
  expect(harness.stateRef.current.tickers.get("AAA")?.metadata.positions).toEqual(reloaded[0]?.metadata.positions);
  expect(harness.stateRef.current.tickers.has("BBB")).toBe(false);
  expect(harness.savedConfigs.at(-1)?.brokerInstances).toEqual([]);
  expect(harness.savedConfigs.at(-1)?.portfolios.some((entry) => entry.id === harness.portfolio.id)).toBe(false);
  expect(profilesAfterFailure).toEqual([harness.instance]);
  expect(savedProfilesAfterFailure).toEqual([harness.instance]);
});

test("profile removal retains a new row published while another row is being saved", async () => {
  const harness = removalHarness();
  const added = createTestTicker("NEW", "Added", { watchlists: ["watchlist"] });
  let addedDuringWrite = false;
  harness.writes.afterSave = async (ticker) => {
    if (ticker.metadata.ticker !== "AAA" || addedDuringWrite) return;
    addedDuringWrite = true;
    await harness.saveEdit(added);
  };

  await harness.pluginRegistry.removeBrokerInstance(harness.instance.id);

  expect(harness.stateRef.current.tickers.get("NEW")).toEqual(added);
  expect(await harness.repository.loadTicker("NEW")).toEqual(added);
  expect(await harness.repository.loadTicker("BBB")).toBeNull();
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
