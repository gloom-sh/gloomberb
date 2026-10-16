import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import { addPaneToLayout, getDockedPaneIds, isPaneInLayout } from "../../layout/pane-manager";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createDefaultConfig, createPaneInstance, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import type { TickerRecord } from "../../types/ticker";
import { createTestTicker } from "../../test-support/ticker";
import { useBrokerImportRuntime } from "./broker-import";

const saved: AppConfig[] = [];
setConfigStoreHost({
  saveConfig: async (config: AppConfig) => { saved.push(config); },
} as unknown as ConfigStoreHost);

const tui = createOpenTuiTestHarness();
afterEach(() => {
  saved.length = 0;
});

const instance: BrokerInstanceConfig = { id: "demo-broker", brokerType: "demo", label: "Demo", config: {}, enabled: true };

function demoBroker(importPositions: () => Promise<BrokerPosition[]>): BrokerAdapter {
  return {
    id: "demo",
    name: "Demo",
    configSchema: [],
    validate: async () => true,
    listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
    importPositions,
  } as unknown as BrokerAdapter;
}

/** The runtime over a store that reduces synchronously, as AppProvider's dispatch does. */
async function renderRuntime(broker: BrokerAdapter, tickerRepository: unknown, tickers: TickerRecord[] = []) {
  const config = { ...createDefaultConfig("/tmp/gloomberb-broker-import-test"), brokerInstances: [instance], portfolioCurrenciesAdopted: true };
  const stateRef: { current: AppState } = { current: { ...createInitialState(config), tickers: new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker])) } };
  const dispatch = (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); };
  let runtime!: ReturnType<typeof useBrokerImportRuntime>;
  function Harness() {
    runtime = useBrokerImportRuntime({
      dispatch,
      pluginRegistry: {
        brokers: new Map([["demo", broker]]),
        persistence: { resources: undefined },
        events: { emit() {} },
      } as any,
      refreshQuote: () => {},
      stateRef,
      tickerRepository: tickerRepository as any,
    });
    return <text>harness</text>;
  }
  await tui.render(<Harness />, { width: 20, height: 2 });
  await act(async () => { await tui.setup().renderOnce(); });
  return { runtime, stateRef, dispatch };
}

// The startup broker sync runs while the app is already usable, and a broker
// such as IBKR Flex takes seconds to answer. It used to commit the whole config
// it had copied before asking, which closed any pane opened in the meantime.
test("the startup broker sync keeps a pane opened while the broker was answering", async () => {
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const tickers = new Map<string, TickerRecord>();
  const tickerRepository = {
    loadAllTickers: async () => [...tickers.values()],
    loadTicker: async (symbol: string) => tickers.get(symbol) ?? null,
    saveTicker: async (ticker: TickerRecord) => { tickers.set(ticker.metadata.ticker, ticker); },
  };
  const { runtime, stateRef, dispatch } = await renderRuntime(demoBroker(async () => { await answered; return []; }), tickerRepository);

  const importing = runtime.autoImportBrokerPositions(new Map(tickers));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pane = createPaneInstance("news", { instanceId: "news:opened-during-sync" });
  const docked = getDockedPaneIds(stateRef.current.config.layout);
  dispatch({ type: "PUSH_LAYOUT_HISTORY" });
  dispatch({
    type: "UPDATE_LAYOUT",
    layout: addPaneToLayout(stateRef.current.config.layout, pane, { relativeTo: docked[docked.length - 1]!, position: "right" }),
  });
  answer();
  await importing;

  const { config: live } = stateRef.current;
  expect(isPaneInLayout(live.layout, pane.instanceId)).toBe(true);
  expect(live.portfolios.some((portfolio) => portfolio.brokerInstanceId === instance.id)).toBe(true);
  expect(live.brokerInstances[0]?.lastSyncedAt).toBeNumber();
  // A config save another test file scheduled can land here too; only this app's count.
  const savedHere = saved.filter((entry) => entry.dataDir === live.dataDir);
  expect(savedHere.length).toBeGreaterThan(0);
  expect(savedHere.every((entry) => isPaneInLayout(entry.layout, pane.instanceId))).toBe(true);
  // The sync leaves the layout alone, so opening the pane can still be undone.
  dispatch({ type: "UNDO_LAYOUT" });
  expect(isPaneInLayout(stateRef.current.config.layout, pane.instanceId)).toBe(false);
});

// A cloud pull can land while a broker sync writes its rows. The sync is in
// the app by then, so the pull merges over it and the sync, finishing, leaves
// what the pull brought.
test("a pull landing while a broker sync writes keeps what both brought", async () => {
  const disk = new Map<string, TickerRecord>();
  let writing!: () => void;
  const startedWriting = new Promise<void>((resolve) => { writing = resolve; });
  let finishWrites!: () => void;
  const writesFinished = new Promise<void>((resolve) => { finishWrites = resolve; });
  const tickerRepository = {
    loadAllTickers: async () => [...disk.values()],
    loadTicker: async (symbol: string) => disk.get(symbol) ?? null,
    // Written when called, as the app's repositories do; the answer comes later.
    saveTicker: async (ticker: TickerRecord) => {
      disk.set(ticker.metadata.ticker, ticker);
      writing();
      await writesFinished;
    },
  };
  const broker = demoBroker(async () => [{ ticker: "AAA", exchange: "NASDAQ", shares: 3, avgCost: 10, currency: "USD", accountId: "ACC-1" }]);
  const { runtime, stateRef, dispatch } = await renderRuntime(broker, tickerRepository, [
    createTestTicker("AAA", "AAA", { watchlists: ["watchlist"] }),
  ]);

  const importing = runtime.importBrokerPositions(instance.id);
  await startedWriting;
  // The pull, merged over what the app holds by then.
  const mainPosition = { portfolio: "main", shares: 4, avgCost: 50, currency: "USD", broker: "manual" };
  const held = stateRef.current.tickers.get("AAA")!;
  const pulled = { metadata: { ...held.metadata, portfolios: [...held.metadata.portfolios, "main"], positions: [...held.metadata.positions, mainPosition] } };
  dispatch({ type: "SET_TICKERS", tickers: new Map(stateRef.current.tickers).set("AAA", pulled) });
  disk.set("AAA", pulled);
  finishWrites();
  await importing;

  expect(stateRef.current.tickers.get("AAA")?.metadata.positions).toEqual([
    expect.objectContaining({ portfolio: "broker:demo-broker:ACC-1", shares: 3 }),
    mainPosition,
  ]);
  expect(disk.get("AAA")).toBe(stateRef.current.tickers.get("AAA")!);
});
