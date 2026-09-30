import { describe, expect, test } from "bun:test";
import type { Dispatch } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerRecord } from "../../../types/ticker";
import { EventBus } from "../../../plugins/event-bus";
import type { PluginRegistry } from "../../../plugins/registry";
import { createCommandBarCollectionWorkflowActions } from "./collection-actions";
import { createTestTicker } from "../../../test-support/ticker";

function ticker(symbol: string, portfolios: string[] = []): TickerRecord {
  return createTestTicker(symbol, symbol, { portfolios });
}

function createHarness(initialTicker: TickerRecord) {
  const state: AppState = {
    ...createInitialState(createDefaultConfig(":memory:")),
    tickers: new Map([[initialTicker.metadata.ticker, initialTicker]]),
  };
  const order: string[] = [];
  const payloads: Array<{ symbol: string; portfolioId: string }> = [];
  const events = new EventBus();
  const pluginRegistry = { events } as PluginRegistry;
  events.on("host:portfolio-ticker-saved", (payload) => {
    order.push("event");
    payloads.push(payload);
  });

  const actions = createCommandBarCollectionWorkflowActions({
    activeCollectionId: "main",
    activeTickerSymbol: initialTicker.metadata.ticker,
    dataProvider: {} as DataProvider,
    dispatch: ((action: AppAction) => {
      expect(action.type).toBe("UPDATE_TICKER");
      order.push("dispatch");
    }) as Dispatch<AppAction>,
    getState: () => state,
    notify: () => {},
    persistConfig: () => {},
    pluginRegistry,
    setActiveCollection: () => {},
    tickerRepository: {
      loadAllTickers: async () => [],
      loadTicker: async () => null,
      saveTicker: async () => {
        order.push("save:start");
        await Promise.resolve();
        order.push("save:end");
      },
      createTicker: async () => initialTicker,
      deleteTicker: async () => {},
    },
  });

  return { actions, order, payloads };
}

describe("command-bar collection workflow actions", () => {
  test("rejects empty acquisition cost before persistence while accepting an explicit zero", async () => {
    const { actions, order } = createHarness(ticker("AAPL"));
    for (const avgCost of ["", "  "]) {
      await expect(actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "AAPL", shares: "10", avgCost }))
        .rejects.toThrow("Avg Cost must be a valid number");
      expect(order).toEqual([]);
    }
    await actions.setPortfolioPositionFromWorkflow({ portfolioId: "main", ticker: "AAPL", shares: "10", avgCost: "0" });
    expect(order).toEqual(["save:start", "save:end", "dispatch", "event"]);
  });

  test("emits portfolio membership after the ticker is saved and dispatched", async () => {
    const { actions, order, payloads } = createHarness(ticker("AAPL"));

    await actions.addTickerMembershipFromWorkflow({
      portfolioId: "main",
      ticker: "AAPL",
    });

    expect(order).toEqual(["save:start", "save:end", "dispatch", "event"]);
    expect(payloads).toEqual([{ symbol: "AAPL", portfolioId: "main" }]);
  });

  test("emits portfolio membership when a resumed AP finds it already durable", async () => {
    const { actions, order, payloads } = createHarness(ticker("AAPL", ["main"]));

    await actions.addTickerMembershipFromWorkflow({
      portfolioId: "main",
      ticker: "AAPL",
    });

    expect(order).toEqual(["event"]);
    expect(payloads).toEqual([{ symbol: "AAPL", portfolioId: "main" }]);
  });

  test("disconnecting a signed-in profile while signed out of Gloom says the account keeps the broker", async () => {
    const signedIn: BrokerInstanceConfig = { id: "ibkr-main", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };
    const config = { ...createDefaultConfig(":memory:"), brokerInstances: [signedIn] };
    const state: AppState = createInitialState(config);
    const removed: string[] = [];
    const notices: Array<{ body: string; type?: string }> = [];
    const actions = createCommandBarCollectionWorkflowActions({
      activeCollectionId: "main",
      activeTickerSymbol: null,
      dataProvider: {} as DataProvider,
      dispatch: (() => {}) as Dispatch<AppAction>,
      getState: () => state,
      notify: (body, options) => notices.push({ body, type: options?.type }),
      persistConfig: () => {},
      pluginRegistry: {
        events: new EventBus(),
        getConfig: () => ({ ...config, brokerInstances: [] }),
        removeBrokerInstance: async (instanceId: string) => { removed.push(instanceId); },
      } as unknown as PluginRegistry,
      setActiveCollection: () => {},
      tickerRepository: {} as never,
    });
    const brokerRequest = apiClient.brokerRequest;
    apiClient.brokerRequest = async () => { throw new ApiRequestError("Unauthorized", 401); };
    try {
      await actions.disconnectBrokerInstance("ibkr-main");
    } finally {
      apiClient.brokerRequest = brokerRequest;
    }

    expect(removed).toEqual(["ibkr-main"]);
    expect(notices).toEqual([{ body: "Removed IBKR. Sign in to Gloom to disconnect IBKR from your account.", type: "info" }]);
  });
});
