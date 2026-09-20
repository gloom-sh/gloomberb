import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { createDefaultConfig, type BrokerInstanceConfig } from "../../types/config";
import type { AppAction } from "./context";
import { initializeAppState } from "./bootstrap";
import type { InstrumentRef } from "../../market-data/request-types";
import type { AppSessionSnapshot } from "../../core/state/session-persistence";

const tempPaths: string[] = [];

function createTempDbPath(name: string): string {
  const path = join(tmpdir(), `gloomberb-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

describe("initializeAppState", () => {
  test("a failed scoped cache read does not discard an independent target or stop startup", async () => {
    const dbPath = createTempDbPath("app-bootstrap-partial-cache");
    const persistence = new AppPersistence(dbPath);
    const repository = new TickerRepository(persistence.tickers);
    const config = createDefaultConfig(dbPath);
    config.recentTickers = [];
    config.layout = { instances: [], dockRoot: null, floating: [], detached: [] };
    const contracts = [101, 202].map((conId) => ({ brokerId: "ibkr", brokerInstanceId: "same", conId, symbol: "DUAL" }));
    await repository.createTicker({ ticker: "DUAL", exchange: "NASDAQ", name: "Dual", currency: "USD", portfolios: [], watchlists: [],
      positions: [], broker_contracts: contracts, custom: {}, tags: [] });
    const targets: InstrumentRef[] = contracts.map((instrument) => ({ symbol: "DUAL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "same", instrument }));
    const primed: Array<[number | undefined, number | undefined]> = [];
    const warmups: InstrumentRef[] = [];
    const actions: AppAction[] = [];
    try {
      await initializeAppState({ config, tickerRepository: repository,
        sessionSnapshot: { paneState: {}, focusedPaneId: null, activePanel: "left", statusBarVisible: true, openPaneIds: [],
          hydrationTargets: targets, exchangeCurrencies: [], savedAt: Date.now() },
        dataProvider: { getCachedFinancialsForTargets: async ([target]: InstrumentRef[]) => {
          if (target!.instrument?.conId === 101) throw new Error("Controlled A cache read failure");
          return new Map([["DUAL", { quote: { symbol: "DUAL", price: 220 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] }]]);
        } } as any,
        dispatch: (action) => { actions.push(action); },
        primeCachedFinancials: (entries) => { primed.push(...entries.map(({ instrument, financials }): [number | undefined, number | undefined] => [instrument.instrument?.conId, financials.quote?.price])); },
        refreshTickersBatch: (entries) => { warmups.push(...entries.map(({ instrument }) => instrument!)); },
        refreshTicker: () => {}, refreshQuote: () => {}, autoImportBrokerPositions: async () => {} });
      expect(primed).toEqual([[202, 220]]);
      expect(warmups).toEqual(targets);
      expect(actions.some(({ type }) => type === "SET_INITIALIZED")).toBe(true);
    } finally { persistence.close(); }
  });

  test("ambiguous symbol-only recents cannot add a guessed legacy contract beside explicit saved targets", async () => {
    const dbPath = createTempDbPath("app-bootstrap-ambiguous-recent");
    const persistence = new AppPersistence(dbPath);
    const repository = new TickerRepository(persistence.tickers);
    const config = createDefaultConfig(dbPath);
    config.recentTickers = ["DUAL", "PLAIN"];
    config.layout = { instances: [], dockRoot: null, floating: [], detached: [] };
    const contracts = ["202610", "202611"].map((lastTradeDateOrContractMonth) => ({ brokerId: "ibkr", brokerInstanceId: "same",
      symbol: "DUAL", localSymbol: "DUAL", secType: "FUT", currency: "USD", lastTradeDateOrContractMonth }));
    for (const ticker of ["DUAL", "PLAIN"]) await repository.createTicker({ ticker, exchange: "NASDAQ", name: ticker, currency: "USD", portfolios: [], watchlists: [],
      positions: [], broker_contracts: ticker === "DUAL" ? contracts : [], custom: {}, tags: [] });
    const target: InstrumentRef = { symbol: "DUAL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "same", instrument: contracts[1] };
    try {
      for (const hydrationTargets of [[], [target]]) {
        const warmups: InstrumentRef[] = [];
        await initializeAppState({ config, tickerRepository: repository, dataProvider: {} as any,
          sessionSnapshot: { paneState: {}, focusedPaneId: null, activePanel: "left", statusBarVisible: true, openPaneIds: [],
            hydrationTargets, exchangeCurrencies: [], savedAt: Date.now() },
          dispatch: () => {}, refreshTicker: (_symbol, _exchange, _ticker, _priority, instrument) => { warmups.push(instrument!); },
          refreshQuote: (_symbol, _exchange, _ticker, _priority, instrument) => { warmups.push(instrument!); }, autoImportBrokerPositions: async () => {} });
        expect(warmups.map(({ symbol, instrument }) => [symbol, instrument?.lastTradeDateOrContractMonth ?? null]))
          .toEqual([...hydrationTargets.map(() => ["DUAL", "202611"]), ["PLAIN", null]]);
      }
    } finally { persistence.close(); }
  });

  test("keeps each reopened cached target through asynchronous symbol-keyed reads and startup warmup", async () => {
    const dbPath = createTempDbPath("app-bootstrap-contracts");
    let persistence = new AppPersistence(dbPath);
    const repository = new TickerRepository(persistence.tickers);
    const config = createDefaultConfig(dbPath);
    config.recentTickers = [];
    config.layout = { instances: [], dockRoot: null, floating: [], detached: [] };
    const contracts = [101, 202].map((conId) => ({ brokerId: "ibkr", brokerInstanceId: "same", conId, symbol: "DUAL" }));
    await repository.createTicker({ ticker: "DUAL", exchange: "NASDAQ", name: "Dual", currency: "USD", portfolios: [], watchlists: [],
      positions: [], broker_contracts: contracts, custom: {}, tags: [] });
    const targets: InstrumentRef[] = contracts.map((instrument) => ({ symbol: "DUAL", exchange: "NASDAQ", brokerId: "ibkr", brokerInstanceId: "same", instrument }));
    targets.push({ symbol: "DUAL", exchange: "NASDAQ", instrument: null });
    persistence.sessions.set("app", { paneState: {}, focusedPaneId: null, activePanel: "left", statusBarVisible: true, openPaneIds: [],
      hydrationTargets: [...targets, targets[0]], exchangeCurrencies: [], savedAt: Date.now() });
    persistence.close();
    persistence = new AppPersistence(dbPath);
    const reads: InstrumentRef[][] = [];
    const primed: Array<{ instrument: InstrumentRef; price: number | undefined }> = [];
    const warmups: InstrumentRef[] = [];
    const events: string[] = [];
    await initializeAppState({ config, tickerRepository: new TickerRepository(persistence.tickers),
      sessionSnapshot: persistence.sessions.get<AppSessionSnapshot>("app")!.value,
      dataProvider: { id: "cached-fixture", name: "Cached fixture", getCachedFinancialsForTargets: async (requested: InstrumentRef[]) => {
        reads.push(requested);
        await new Promise((resolve) => setTimeout(resolve, requested[0]?.instrument?.conId === 101 ? 5 : 0));
        return new Map(requested.map((target) => [target.symbol, { quote: { symbol: target.symbol, price: target.instrument?.conId ?? 50 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] }]));
      } } as any,
      dispatch: (action) => { events.push(action.type); },
      primeCachedFinancials: (entries) => { events.push("prime"); primed.push(...entries.map(({ instrument, financials }) => ({ instrument, price: financials.quote?.price }))); },
      refreshTickersBatch: (entries) => { warmups.push(...entries.map(({ instrument }) => instrument!)); },
      refreshTicker: () => {}, refreshQuote: () => {}, autoImportBrokerPositions: async () => {} });
    expect(reads.map((read) => read.length)).toEqual([1, 1, 1]);
    expect(primed.map(({ instrument, price }) => [instrument.instrument?.conId ?? null, price])).toEqual([[101, 101], [202, 202], [null, 50]]);
    expect(warmups).toEqual(targets);
    expect(events.indexOf("prime")).toBeLessThan(events.indexOf("SET_INITIALIZED"));
    persistence.close();
  });

  test("effective saved-layout collection wins over an older session during startup target selection", async () => {
    const dbPath = createTempDbPath("app-bootstrap-effective-collection");
    const persistence = new AppPersistence(dbPath);
    const repository = new TickerRepository(persistence.tickers);
    const config = createDefaultConfig(dbPath);
    config.recentTickers = [];
    config.portfolios = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    config.layout = { dockRoot: { kind: "pane", instanceId: "pf" }, floating: [], detached: [],
      instances: [{ instanceId: "pf", paneId: "portfolio-list", params: { collectionId: "a" }, settings: { columnIds: ["ticker", "price"] } }] };
    config.layouts = [{ name: "Saved B", layout: config.layout, paneState: { pf: { collectionId: "b" } } }];
    const contracts = [101, 202].map((conId) => ({ brokerId: "ibkr", brokerInstanceId: "same", conId, symbol: "DUAL" }));
    await repository.createTicker({ ticker: "DUAL", exchange: "NASDAQ", name: "Dual", currency: "USD", portfolios: ["a", "b"], watchlists: [],
      positions: contracts.map((c, i) => ({ portfolio: i ? "b" : "a", broker: "ibkr", brokerInstanceId: "same", brokerContractId: c.conId, shares: 1 })),
      broker_contracts: contracts, custom: {}, tags: [] });
    const sessionSnapshot: AppSessionSnapshot = { paneState: { pf: { collectionId: "a" } }, focusedPaneId: "pf", activePanel: "left",
      statusBarVisible: true, openPaneIds: ["pf"], hydrationTargets: [], exchangeCurrencies: [], savedAt: Date.now() };
    for (const [paneState, expected] of [[undefined, 202], [{ pf: { collectionId: "a" } }, 101]] as const) {
      const targets: InstrumentRef[] = [];
      await initializeAppState({ config, tickerRepository: repository, dataProvider: {} as any, sessionSnapshot, paneState,
        dispatch: () => {}, refreshTicker: () => {}, refreshQuote: (_symbol, _exchange, _ticker, _priority, instrument) => { targets.push(instrument!); },
        autoImportBrokerPositions: async () => {} });
      expect(targets.map(({ instrument }) => instrument?.conId)).toEqual([expected]);
    }
    persistence.close();
  });

  // Loading tickers and priming caches runs while the app is already on
  // screen, so the row a user picks during startup must outlive the seed that
  // was computed before they picked it.
  test("a cursor chosen during startup survives the pane-state seed", async () => {
    const dbPath = createTempDbPath("app-bootstrap-seed-race");
    const persistence = new AppPersistence(dbPath);
    const repository = new TickerRepository(persistence.tickers);
    const config = createDefaultConfig(dbPath);
    config.recentTickers = [];
    for (const ticker of ["AAPL", "NVDA"]) {
      await repository.createTicker({
        ticker, exchange: "NASDAQ", currency: "USD", name: ticker,
        portfolios: [], watchlists: [config.watchlists[0]?.id ?? "watchlist"],
        positions: [], broker_contracts: [], custom: {}, tags: [],
      });
    }
    const seeded: Array<[string, unknown]> = [];
    // The user clicked NVDA while startup was still reading the ticker store.
    const livePaneState = { "portfolio-list:main": { cursorSymbol: "NVDA" } };

    try {
      await initializeAppState({
        config,
        tickerRepository: repository,
        dataProvider: {} as any,
        sessionSnapshot: null,
        paneState: {},
        getPaneState: () => livePaneState,
        dispatch: (action) => {
          if (action.type === "UPDATE_PANE_STATE") seeded.push([action.paneId, action.patch.cursorSymbol]);
        },
        refreshTicker: () => {},
        refreshQuote: () => {},
        autoImportBrokerPositions: async () => {},
      });

      expect(seeded).toEqual([]);
    } finally {
      persistence.close();
    }
  });

  test("hydrates persisted broker account snapshots into app state before broker sync", async () => {
    const dbPath = createTempDbPath("app-bootstrap");
    const persistence = new AppPersistence(dbPath);
    const tickerRepository = new TickerRepository(persistence.tickers);
    const brokerInstance: BrokerInstanceConfig = {
      id: "ibkr-live",
      brokerType: "ibkr",
      label: "Interactive Brokers",
      connectionMode: "gateway",
      config: { connectionMode: "gateway", gateway: { host: "127.0.0.1", port: 4002, clientId: 1 } },
      enabled: true,
    };
    const config = {
      ...createDefaultConfig(dbPath),
      brokerInstances: [brokerInstance],
    };

    const actions: AppAction[] = [];

    await initializeAppState({
      config,
      tickerRepository,
      dataProvider: {} as any,
      sessionSnapshot: null,
      dispatch: (action) => { actions.push(action); },
      refreshTicker: () => {},
      refreshQuote: () => {},
      autoImportBrokerPositions: async () => {},
      persistedBrokerAccounts: {
        "ibkr-live": [{
          accountId: "DU12345",
          name: "DU12345",
          currency: "USD",
          source: "gateway",
          updatedAt: 1_717_000_000_000,
          totalCashValue: 125000,
        }],
      },
    });

    expect(actions).toContainEqual({
      type: "SET_BROKER_ACCOUNTS",
      instanceId: "ibkr-live",
      accounts: [{
        accountId: "DU12345",
        name: "DU12345",
        currency: "USD",
        source: "gateway",
        updatedAt: 1_717_000_000_000,
        totalCashValue: 125000,
      }],
    });

    const initializedIndex = actions.findIndex((action) => action.type === "SET_INITIALIZED");
    const brokerAccountsIndex = actions.findIndex((action) =>
      action.type === "SET_BROKER_ACCOUNTS" && action.instanceId === "ibkr-live"
    );
    expect(brokerAccountsIndex).toBeGreaterThan(-1);
    expect(initializedIndex).toBeGreaterThan(brokerAccountsIndex);

    persistence.close();
  });

  test("uses quote warmup for quote-only collection panes and financial warmup for ticker panes", async () => {
    const dbPath = createTempDbPath("app-bootstrap-refresh-plan");
    const persistence = new AppPersistence(dbPath);
    const tickerRepository = new TickerRepository(persistence.tickers);
    const defaultConfig = createDefaultConfig(dbPath);
    const quoteOnlyConfig = {
      ...defaultConfig,
      layout: {
        ...defaultConfig.layout,
        dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        instances: defaultConfig.layout.instances
          .filter((instance) => instance.paneId === "portfolio-list")
          .map((instance) => ({
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: ["ticker", "price", "change_pct", "latency"],
            },
          })),
      },
      layouts: defaultConfig.layouts.map((entry) => ({
        ...entry,
        layout: {
          ...entry.layout,
          dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
          instances: entry.layout.instances
            .filter((instance) => instance.paneId === "portfolio-list")
            .map((instance) => ({
              ...instance,
              settings: {
                ...(instance.settings ?? {}),
                columnIds: ["ticker", "price", "change_pct", "latency"],
              },
            })),
        },
      })),
    };

    await tickerRepository.createTicker({
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });

    const quoteRefreshes: string[] = [];
    const financialRefreshes: string[] = [];

    await initializeAppState({
      config: quoteOnlyConfig,
      tickerRepository,
      dataProvider: {} as any,
      sessionSnapshot: null,
      dispatch: () => {},
      refreshTicker: (symbol) => { financialRefreshes.push(symbol); },
      refreshQuote: (symbol) => { quoteRefreshes.push(symbol); },
      autoImportBrokerPositions: async () => {},
    });

    expect(quoteRefreshes).toEqual(["AAPL"]);
    expect(financialRefreshes).toEqual([]);

    quoteRefreshes.length = 0;
    financialRefreshes.length = 0;

    await initializeAppState({
      config: defaultConfig,
      tickerRepository,
      dataProvider: {} as any,
      sessionSnapshot: null,
      dispatch: () => {},
      refreshTicker: (symbol) => { financialRefreshes.push(symbol); },
      refreshQuote: (symbol) => { quoteRefreshes.push(symbol); },
      autoImportBrokerPositions: async () => {},
    });

    expect(financialRefreshes).toEqual(["AAPL"]);
    expect(quoteRefreshes).toEqual([]);

    persistence.close();
  });

  test("uses financial warmup for collection panes that show fundamentals columns", async () => {
    const dbPath = createTempDbPath("app-bootstrap-financial-collection");
    const persistence = new AppPersistence(dbPath);
    const tickerRepository = new TickerRepository(persistence.tickers);
    const defaultConfig = createDefaultConfig(dbPath);
    const financialCollectionConfig = {
      ...defaultConfig,
      layout: {
        ...defaultConfig.layout,
        dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        instances: defaultConfig.layout.instances
          .filter((instance) => instance.paneId === "portfolio-list")
          .map((instance) => ({
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: ["ticker", "market_cap", "pe", "forward_pe"],
            },
          })),
      },
      layouts: defaultConfig.layouts.map((entry) => ({
        ...entry,
        layout: {
          ...entry.layout,
          dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
          instances: entry.layout.instances
            .filter((instance) => instance.paneId === "portfolio-list")
            .map((instance) => ({
              ...instance,
              settings: {
                ...(instance.settings ?? {}),
                columnIds: ["ticker", "market_cap", "pe", "forward_pe"],
              },
            })),
        },
      })),
    };

    await tickerRepository.createTicker({
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });

    const quoteRefreshes: string[] = [];
    const financialRefreshes: string[] = [];

    await initializeAppState({
      config: financialCollectionConfig,
      tickerRepository,
      dataProvider: {} as any,
      sessionSnapshot: null,
      dispatch: () => {},
      refreshTicker: (symbol) => { financialRefreshes.push(symbol); },
      refreshQuote: (symbol) => { quoteRefreshes.push(symbol); },
      autoImportBrokerPositions: async () => {},
    });

    expect(financialRefreshes).toEqual(["AAPL"]);
    expect(quoteRefreshes).toEqual([]);

    persistence.close();
  });

  test("restores background hydration targets even when another collection row is selected", async () => {
    const dbPath = createTempDbPath("app-bootstrap-hydration-targets");
    const persistence = new AppPersistence(dbPath);
    const tickerRepository = new TickerRepository(persistence.tickers);
    const defaultConfig = createDefaultConfig(dbPath);
    const quoteOnlyConfig = {
      ...defaultConfig,
      layout: {
        ...defaultConfig.layout,
        dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        instances: defaultConfig.layout.instances
          .filter((instance) => instance.paneId === "portfolio-list")
          .map((instance) => ({
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: ["ticker", "price", "change_pct", "latency"],
            },
          })),
      },
      layouts: defaultConfig.layouts.map((entry) => ({
        ...entry,
        layout: {
          ...entry.layout,
          dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
          instances: entry.layout.instances
            .filter((instance) => instance.paneId === "portfolio-list")
            .map((instance) => ({
              ...instance,
              settings: {
                ...(instance.settings ?? {}),
                columnIds: ["ticker", "price", "change_pct", "latency"],
              },
            })),
        },
      })),
    };

    await tickerRepository.createTicker({
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });
    await tickerRepository.createTicker({
      ticker: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      name: "NVIDIA Corporation",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });

    const quoteRefreshes: string[] = [];
    const financialRefreshes: string[] = [];

    await initializeAppState({
      config: quoteOnlyConfig,
      tickerRepository,
      dataProvider: {} as any,
      sessionSnapshot: {
        paneState: {
          "portfolio-list:main": {
            collectionId: "main",
            cursorSymbol: "NVDA",
          },
        },
        focusedPaneId: "portfolio-list:main",
        activePanel: "left",
        statusBarVisible: true,
        openPaneIds: ["portfolio-list:main"],
        hydrationTargets: [{
          symbol: "AAPL",
          exchange: "NASDAQ",
          instrument: null,
        }],
        exchangeCurrencies: [],
        savedAt: Date.now(),
      },
      dispatch: () => {},
      refreshTicker: (symbol) => { financialRefreshes.push(symbol); },
      refreshQuote: (symbol) => { quoteRefreshes.push(symbol); },
      autoImportBrokerPositions: async () => {},
    });

    expect(quoteRefreshes).toEqual(["NVDA"]);
    expect(financialRefreshes).toEqual(["AAPL"]);

    persistence.close();
  });

  test("primes cached financials for background hydration targets before initialization", async () => {
    const dbPath = createTempDbPath("app-bootstrap-prime-cached-financials");
    const persistence = new AppPersistence(dbPath);
    const tickerRepository = new TickerRepository(persistence.tickers);
    const defaultConfig = createDefaultConfig(dbPath);
    const quoteOnlyConfig = {
      ...defaultConfig,
      layout: {
        ...defaultConfig.layout,
        dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
        instances: defaultConfig.layout.instances
          .filter((instance) => instance.paneId === "portfolio-list")
          .map((instance) => ({
            ...instance,
            settings: {
              ...(instance.settings ?? {}),
              columnIds: ["ticker", "price", "change_pct", "latency"],
            },
          })),
      },
      layouts: defaultConfig.layouts.map((entry) => ({
        ...entry,
        layout: {
          ...entry.layout,
          dockRoot: { kind: "pane" as const, instanceId: "portfolio-list:main" },
          instances: entry.layout.instances
            .filter((instance) => instance.paneId === "portfolio-list")
            .map((instance) => ({
              ...instance,
              settings: {
                ...(instance.settings ?? {}),
                columnIds: ["ticker", "price", "change_pct", "latency"],
              },
            })),
        },
      })),
    };

    await tickerRepository.createTicker({
      ticker: "AAPL",
      exchange: "NASDAQ",
      currency: "USD",
      name: "Apple Inc.",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });
    await tickerRepository.createTicker({
      ticker: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      name: "NVIDIA Corporation",
      portfolios: [],
      watchlists: ["main"],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    });
    const hydrationSymbols = [
      "AAPL",
      ...Array.from({ length: 13 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`),
    ];
    for (const symbol of hydrationSymbols.slice(1)) {
      await tickerRepository.createTicker({
        ticker: symbol,
        exchange: "NASDAQ",
        currency: "USD",
        name: symbol,
        portfolios: [],
        watchlists: ["main"],
        positions: [],
        broker_contracts: [],
        custom: {},
        tags: [],
      });
    }

    const events: string[] = [];
    const cachedTargetRequests: string[] = [];
    const financialRefreshes: string[] = [];

    await initializeAppState({
      config: quoteOnlyConfig,
      tickerRepository,
      dataProvider: {
        id: "test-provider",
        name: "Test Provider",
        getCachedFinancialsForTargets: (targets: Array<{ symbol: string }>) => {
          cachedTargetRequests.push(...targets.map((target) => target.symbol));
          return new Map(targets.map((target) => [target.symbol, {
            annualStatements: [],
            quarterlyStatements: [],
            priceHistory: [],
            quote: {
              symbol: target.symbol,
              price: 200,
              currency: "USD",
              change: 1,
              changePercent: 0.5,
              marketCap: 2_000_000_000,
              lastUpdated: Date.now(),
            },
            fundamentals: {
              trailingPE: 25,
            },
          }]));
        },
      } as any,
      sessionSnapshot: {
        paneState: {
          "portfolio-list:main": {
            collectionId: "main",
            cursorSymbol: "NVDA",
          },
        },
        focusedPaneId: "portfolio-list:main",
        activePanel: "left",
        statusBarVisible: true,
        openPaneIds: ["portfolio-list:main"],
        hydrationTargets: hydrationSymbols.map((symbol) => ({
          symbol,
          exchange: "NASDAQ",
          instrument: null,
        })),
        exchangeCurrencies: [],
        savedAt: Date.now(),
      },
      dispatch: (action) => { events.push(action.type); },
      primeCachedFinancials: (entries) => {
        events.push(`prime:${entries.map((entry) => entry.ticker.metadata.ticker).join(",")}`);
      },
      refreshTicker: (symbol) => { financialRefreshes.push(symbol); },
      refreshQuote: () => {},
      autoImportBrokerPositions: async () => {},
    });

    const primeEvent = events.find((event) => event.startsWith("prime:"));
    expect(primeEvent).toContain("AAPL");
    expect(primeEvent).toContain("T13");
    expect(cachedTargetRequests).toContain("T13");
    expect(financialRefreshes).not.toContain("T13");
    expect(events.indexOf(primeEvent!)).toBeLessThan(events.indexOf("SET_INITIALIZED"));

    persistence.close();
  });
});
