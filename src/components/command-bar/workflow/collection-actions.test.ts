import { describe, expect, test } from "bun:test";
import type { Dispatch } from "react";
import { createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { DataProvider } from "../../../types/data-provider";
import type { TickerPosition, TickerRecord } from "../../../types/ticker";
import { EventBus } from "../../../plugins/event-bus";
import type { PluginRegistry } from "../../../plugins/registry";
import { createCommandBarCollectionWorkflowActions } from "./collection-actions";
import { createTestTicker } from "../../../test-support/ticker";
import { buildAddToPortfolioWorkflow, buildSetPortfolioPositionWorkflow } from "./portfolio-position";

function ticker(symbol: string, portfolios: string[] = []): TickerRecord {
  return createTestTicker(symbol, symbol, { portfolios });
}

function createHarness(initialTicker: TickerRecord) {
  const state: AppState = {
    ...createInitialState(createDefaultConfig(":memory:")),
    tickers: new Map([[initialTicker.metadata.ticker, initialTicker]]),
  };
  const order: string[] = [];
  const saved: TickerRecord[] = [];
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
      saveTicker: async (record) => {
        saved.push(record);
        order.push("save:start");
        await Promise.resolve();
        order.push("save:end");
      },
      createTicker: async () => initialTicker,
      deleteTicker: async () => {},
    },
  });

  return { actions, order, payloads, saved };
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

  test("saving the position form unchanged keeps the total shares and cost basis of several lots", async () => {
    const lot = (shares: number, avgCost: number, dateAcquired: string): TickerPosition =>
      ({ portfolio: "main", broker: "manual", shares, avgCost, currency: "USD", dateAcquired });
    const holding = createTestTicker("AAPL", "Apple", {
      portfolios: ["main"],
      positions: [lot(10, 150, "2024-01-02"), lot(5, 170, "2024-06-03")],
    });
    const config = createDefaultConfig(":memory:");
    for (const form of [
      buildSetPortfolioPositionWorkflow(config, { activeCollectionId: "main", activeTicker: holding }),
      buildAddToPortfolioWorkflow(config, { preferredPortfolioId: "main", ticker: holding }),
    ]) {
      const { actions, saved } = createHarness(holding);

      await actions.setPortfolioPositionFromWorkflow(form!.values);

      const positions = saved[0]!.metadata.positions;
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({ portfolio: "main", broker: "manual", shares: 15, currency: "USD" });
      expect(positions[0]!.shares * positions[0]!.avgCost!).toBeCloseTo(10 * 150 + 5 * 170, 9);
    }
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
});
