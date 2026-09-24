import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";
import { addPaneToLayout, getDockedPaneIds, isPaneInLayout } from "../../plugins/pane-manager";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createDefaultConfig, createPaneInstance, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { BrokerAdapter } from "../../types/broker";
import type { TickerRecord } from "../../types/ticker";
import { useBrokerImportRuntime } from "./broker-import";

const saved: AppConfig[] = [];
setConfigStoreHost({
  saveConfig: async (config: AppConfig) => { saved.push(config); },
} as unknown as ConfigStoreHost);

let rendered: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => {
  saved.length = 0;
  if (rendered) await act(async () => { rendered!.renderer.destroy(); });
  rendered = undefined;
});

// The startup broker sync runs while the app is already usable, and a broker
// such as IBKR Flex takes seconds to answer. It used to commit the whole config
// it had copied before asking, which closed any pane opened in the meantime.
test("the startup broker sync keeps a pane opened while the broker was answering", async () => {
  const instance: BrokerInstanceConfig = { id: "demo-broker", brokerType: "demo", label: "Demo", config: {}, enabled: true };
  const config = { ...createDefaultConfig("/tmp/gloomberb-broker-import-test"), brokerInstances: [instance] };
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  const broker = {
    id: "demo",
    name: "Demo",
    configSchema: [],
    validate: async () => true,
    listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
    importPositions: async () => { await answered; return []; },
  } as unknown as BrokerAdapter;
  const tickers = new Map<string, TickerRecord>();
  const tickerRepository = {
    loadAllTickers: async () => [...tickers.values()],
    loadTicker: async (symbol: string) => tickers.get(symbol) ?? null,
    saveTicker: async (ticker: TickerRecord) => { tickers.set(ticker.metadata.ticker, ticker); },
  } as any;

  // AppProvider's dispatch reduces into the ref synchronously.
  const stateRef: { current: AppState } = { current: createInitialState(config) };
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
      tickerRepository,
    });
    return <text>harness</text>;
  }
  rendered = await testRender(<Harness />, { width: 20, height: 2 });
  await act(async () => { await rendered!.renderOnce(); });

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
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.every((entry) => isPaneInLayout(entry.layout, pane.instanceId))).toBe(true);
  // The sync leaves the layout alone, so opening the pane can still be undone.
  dispatch({ type: "UNDO_LAYOUT" });
  expect(isPaneInLayout(stateRef.current.config.layout, pane.instanceId)).toBe(false);
});
