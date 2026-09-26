import { describe, expect, test } from "bun:test";
import { createDefaultConfig, createPaneInstance } from "../types/config";
import type { TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { buildAppSessionSnapshot, reconcileAppSessionSnapshot } from "../core/state/session-persistence";
import { instrumentIdentityKey } from "../utils/instrument-identity";

function createTicker(symbol: string, exchange = "NASDAQ"): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange,
      currency: "USD",
      name: symbol,
      portfolios: ["main"],
      watchlists: [],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    },
  };
}

describe("session persistence", () => {
  test("saves portfolio and follower targets without selecting the first contract or resolving ambiguous lots", () => {
    const config = createDefaultConfig("/tmp/session-contracts");
    config.portfolios = ["a", "b", "manual", "unknown"].map((id) => ({ id, name: id }));
    const contracts = [101, 202].map((conId) => ({ brokerId: "ibkr", brokerInstanceId: "same", symbol: "DUAL", conId }));
    const ticker = createTicker("DUAL");
    ticker.metadata.portfolios = config.portfolios.map(({ id }) => id);
    ticker.metadata.broker_contracts = contracts;
    ticker.metadata.positions = [
      ...contracts.map((contract, index) => ({ portfolio: index ? "b" : "a", broker: "ibkr", brokerInstanceId: "same", brokerContractId: contract.conId, shares: 1 })),
      { portfolio: "manual", broker: "manual", shares: 1 },
      { portfolio: "unknown", broker: "ibkr", brokerInstanceId: "same", brokerContractId: 999, shares: 1 },
    ];
    config.layout.instances = config.portfolios.map(({ id }) => createPaneInstance("portfolio-list", { instanceId: id, params: { collectionId: id } }));
    config.layout.instances.push(createPaneInstance("ticker-detail", { instanceId: "follow-b", binding: { kind: "follow", sourceInstanceId: "b" } }));
    const state = { config, paneState: Object.fromEntries(config.portfolios.map(({ id }) => [id, { cursorSymbol: "DUAL", collectionId: id }])),
      focusedPaneId: "b", activePanel: "left" as const, statusBarVisible: true, recentTickers: [], tickers: new Map([["DUAL", ticker]]), exchangeRates: new Map<string, number>() };
    const snapshot = buildAppSessionSnapshot(state);
    expect(snapshot.hydrationTargets.map(({ instrument }) => instrument?.conId ?? null)).toEqual([101, 202, null]);
    expect(snapshot.hydrationTargets.map(instrumentIdentityKey)).toHaveLength(3);
    expect(ticker.metadata.broker_contracts).toEqual(contracts);
    // A stale cursor does not change which collection supplies other rows.
    state.paneState.b.cursorSymbol = "MISSING";
    expect(buildAppSessionSnapshot(state).hydrationTargets.some(({ instrument }) => instrument?.conId === 202)).toBe(true);
    expect(buildAppSessionSnapshot(state).hydrationTargets.some(({ symbol }) => symbol === "MISSING")).toBe(false);
  });

  test("fixed and followed legacy contracts keep full distinct identities in the saved working set", () => {
    const config = createDefaultConfig("/tmp/session-fixed-contracts");
    const ticker = createTicker("DUAL");
    const contracts = ["202610", "202611"].map((lastTradeDateOrContractMonth) => ({ brokerId: "ibkr", brokerInstanceId: "same",
      symbol: "DUAL", localSymbol: "DUAL", secType: "FUT", currency: "USD", lastTradeDateOrContractMonth }));
    ticker.metadata.broker_contracts = contracts;
    config.layout.instances = contracts.map((instrument, index) => createPaneInstance("ticker-detail", {
      instanceId: `fixed:${index}`, binding: { kind: "fixed", symbol: "DUAL", instrument },
    }));
    config.layout.instances.push(createPaneInstance("ticker-detail", { instanceId: "follow", binding: { kind: "follow", sourceInstanceId: "fixed:1" } }));
    const snapshot = buildAppSessionSnapshot({ config, paneState: {}, focusedPaneId: "follow", activePanel: "right", statusBarVisible: true,
      recentTickers: ["DUAL"], tickers: new Map([["DUAL", ticker]]), exchangeRates: new Map() });
    expect(snapshot.hydrationTargets.map(({ instrument }) => instrument?.lastTradeDateOrContractMonth)).toEqual(["202610", "202611"]);
    expect(new Set(snapshot.hydrationTargets.map(instrumentIdentityKey)).size).toBe(2);
    config.layout.instances = [];
    expect(buildAppSessionSnapshot({ config, paneState: {}, focusedPaneId: null, activePanel: "right", statusBarVisible: true,
      recentTickers: ["DUAL"], tickers: new Map([["DUAL", ticker]]), exchangeRates: new Map() }).hydrationTargets).toEqual([]);
  });

  test("builds a working-set snapshot from runtime state", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const tickers = new Map<string, TickerRecord>([
      ["AAPL", createTicker("AAPL")],
      ["MSFT", createTicker("MSFT")],
    ]);
    const financials = new Map<string, TickerFinancials>([["AAPL", {
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: {
        symbol: "AAPL",
        price: 100,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.now(),
      },
    }]]);

    const snapshot = buildAppSessionSnapshot({
      config,
      paneState: {
        "portfolio-list:main": {
          cursorSymbol: "AAPL",
          collectionId: "main",
          collectionSorts: {
            main: { columnId: "mkt_value", direction: "desc" },
          },
        },
        "ticker-detail:main": { activeTabId: "financials" },
      },
      focusedPaneId: "ticker-detail:main",
      activePanel: "right",
      statusBarVisible: true,
      recentTickers: ["AAPL"],
      tickers,
      financials,
      exchangeRates: new Map([["USD", 1], ["JPY", 0.0067]]),
    });

    expect(snapshot.focusedPaneId).toBe("ticker-detail:main");
    expect(snapshot.hydrationTargets.map((target) => target.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(snapshot.exchangeCurrencies).toContain("JPY");
    expect(snapshot.paneState["portfolio-list:main"]).toEqual({
      cursorSymbol: "AAPL",
      collectionId: "main",
      collectionSorts: {
        main: { columnId: "mkt_value", direction: "desc" },
      },
    });
    expect(snapshot.paneState["ticker-detail:main"]).toEqual({ activeTabId: "financials" });
  });

  test("reconciles pane state and broker references against the current config", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    config.brokerInstances.push({
      id: "ibkr-live",
      brokerType: "ibkr",
      label: "IBKR",
      config: {},
      enabled: true,
    });
    const orphanPane = createPaneInstance("ticker-detail", {
      instanceId: "ticker-detail:orphan",
      binding: { kind: "follow", sourceInstanceId: "missing" },
    });
    config.layout.instances.push(orphanPane);

    const reconciled = reconcileAppSessionSnapshot(config, {
      paneState: {
        "portfolio-list:main": {
          cursorSymbol: "AAPL",
          collectionId: "main",
          collectionSorts: {
            main: { columnId: "mkt_value", direction: "desc" },
          },
        },
        "ticker-detail:main": {
          activeTabId: "chart",
          pluginState: {
            "ticker-detail": { detailMetric: "revenue", shared: "legacy" },
            "ticker-research": { shared: "canonical" },
          },
        },
        "missing:pane": { cursorSymbol: "MSFT" },
      },
      focusedPaneId: "missing:pane",
      activePanel: "right",
      statusBarVisible: false,
      openPaneIds: ["portfolio-list:main", "missing:pane"],
      hydrationTargets: [
        { symbol: "AAPL", brokerInstanceId: "ibkr-live", brokerId: "ibkr" },
        { symbol: "MSFT", brokerInstanceId: "ibkr-missing", brokerId: "ibkr" },
      ],
      exchangeCurrencies: ["USD", "JPY"],
      savedAt: Date.now(),
    });

    expect(reconciled?.paneState["portfolio-list:main"]).toEqual({
      cursorSymbol: "AAPL",
      collectionId: "main",
      collectionSorts: {
        main: { columnId: "mkt_value", direction: "desc" },
      },
    });
    expect(reconciled?.paneState["ticker-detail:main"]).toEqual({
      activeTabId: "chart",
      pluginState: {
        "ticker-research": { detailMetric: "revenue", shared: "canonical" },
      },
    });
    expect(reconciled?.paneState["missing:pane"]).toBeUndefined();
    expect(reconciled?.focusedPaneId).toBe("portfolio-list:main");
    expect(reconciled?.hydrationTargets).toEqual([{ symbol: "AAPL", brokerInstanceId: "ibkr-live", brokerId: "ibkr", exchange: undefined, instrument: null }]);
  });
});
