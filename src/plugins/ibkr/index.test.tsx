import { describe, expect, test } from "bun:test";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../../types/config";
import type { CommandDef, GloomPluginContext, TickerAction } from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import { ibkrPlugin } from "./index";

function createTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function createGatewayInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-paper",
    brokerType: "ibkr",
    label: "Paper",
    connectionMode: "gateway",
    config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
    enabled: true,
  };
}

function createFlexInstance(): BrokerInstanceConfig {
  return {
    id: "ibkr-flex",
    brokerType: "ibkr",
    label: "Flex",
    connectionMode: "flex",
    config: { connectionMode: "flex", flex: { token: "token", queryId: "query" } },
    enabled: true,
  };
}

function createConfig(brokerInstances: BrokerInstanceConfig[] = []): AppConfig {
  return {
    ...createDefaultConfig("/tmp/gloomberb-test"),
    brokerInstances,
  };
}

function setupIbkrPlugin(config: AppConfig) {
  const commands: CommandDef[] = [];
  const tickerActions: TickerAction[] = [];
  const toasts: string[] = [];
  const switchedPanels: string[] = [];
  const switchedTabs: string[] = [];
  const tickers = new Map<string, TickerRecord>([["AAPL", createTicker("AAPL")]]);

  const ctx = {
    registerPane: () => {},
    registerPaneTemplate: () => {},
    registerCommand: (command: CommandDef) => { commands.push(command); },
    registerColumn: () => {},
    registerBroker: () => {},
    registerCapability: () => {},
    registerTickerResearchTab: () => {},
    registerShortcut: () => {},
    registerTickerAction: (action: TickerAction) => { tickerActions.push(action); },
    getData: () => null,
    getTicker: (symbol: string) => tickers.get(symbol) ?? null,
    getConfig: () => config,
    getPaneDef: () => undefined,
    persistence: {} as any,
    storage: {} as any,
    marketData: {} as any,
    tickerRepository: {} as any,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resume: {
      getState: () => null,
      setState: () => {},
      deleteState: () => {},
      getPaneState: () => null,
      setPaneState: () => {},
      deletePaneState: () => {},
    },
    configState: {
      get: () => null,
      set: async () => {},
      delete: async () => {},
      keys: () => [],
    },
    createBrokerInstance: async () => { throw new Error("unused"); },
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    selectTicker: () => {},
    switchPanel: (panel: "left" | "right") => { switchedPanels.push(panel); },
    switchTab: (tabId: string) => { switchedTabs.push(tabId); },
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    focusPane: () => {},
    pinTicker: () => {},
    on: () => () => {},
    emit: () => {},
    notify: ({ body }: { body: string }) => { toasts.push(body); },
  } satisfies GloomPluginContext;

  void ibkrPlugin.setup?.(ctx);

  return { commands, tickerActions, toasts, switchedPanels, switchedTabs, ticker: tickers.get("AAPL")! };
}

describe("IBKR trade entry points", () => {
  test("hides the Trade action when no IBKR gateway profile is configured", () => {
    const { tickerActions, ticker } = setupIbkrPlugin(createConfig());
    const tradeAction = tickerActions.find((action) => action.id === "ibkr-trade");

    expect(tradeAction).toBeDefined();
    expect(tradeAction?.filter?.(ticker)).toBe(false);
  });

  test("hides the Trade action and trading commands for flex-only setups", () => {
    const { commands, tickerActions, ticker } = setupIbkrPlugin(createConfig([createFlexInstance()]));
    const tradeAction = tickerActions.find((action) => action.id === "ibkr-trade");
    const openTrading = commands.find((command) => command.id === "ibkr-open-trading");
    const buySelected = commands.find((command) => command.id === "ibkr-buy-selected");
    const sellSelected = commands.find((command) => command.id === "ibkr-sell-selected");

    expect(tradeAction?.filter?.(ticker)).toBe(false);
    expect(openTrading?.hidden?.()).toBe(true);
    expect(buySelected?.hidden?.()).toBe(true);
    expect(sellSelected?.hidden?.()).toBe(true);
  });

  test("allows the Trade action when a gateway profile exists", () => {
    const { tickerActions, ticker } = setupIbkrPlugin(createConfig([createGatewayInstance()]));
    const tradeAction = tickerActions.find((action) => action.id === "ibkr-trade");

    expect(tradeAction?.filter?.(ticker)).toBe(true);
  });

  test("shows a clear message and does not navigate when Open Trading is executed without a gateway profile", async () => {
    const { commands, switchedPanels, switchedTabs, toasts } = setupIbkrPlugin(createConfig());
    const openTrading = commands.find((command) => command.id === "ibkr-open-trading");

    expect(openTrading).toBeDefined();
    await openTrading!.execute();

    expect(toasts).toEqual(["Connect a Gateway / TWS IBKR profile first."]);
    expect(switchedPanels).toHaveLength(0);
    expect(switchedTabs).toHaveLength(0);
  });

});
