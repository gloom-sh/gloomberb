import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, type AppConfig, type BrokerInstanceConfig } from "../types/config";
import type { BrokerAdapter } from "../types/broker";
import type { Portfolio, TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import { hydrateTickerMetadata } from "../tickers/metadata";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { getColumnValue, getSortValue } from "../plugins/builtin/portfolio-list/column-values";
import { showCollection } from "../plugins/builtin/portfolio-list/cli/render";
import { createTestDataProvider, createTestQuote } from "../test-support/data-provider";
import { bindPluginRegistryRuntimeAccess } from "../app/runtime/plugin-bindings";
import { MemoryResourceStore } from "../data/memory-resource-store";
import type { PluginRegistry } from "../plugins/registry";
import { appReducer, createInitialState, type AppAction, type AppState } from "../state/app/context";
import { loadPersistedBrokerAccounts, persistBrokerAccounts } from "./account-cache";
import { createSignedInBrokerAdapter } from "./signed-in/adapter";
import {
  restoreBrokerPortfoliosFromTickerPositions,
  syncBrokerInstance,
  syncBrokerInstances,
} from "./sync-broker-instance";
import { createTestTicker } from "../test-support/ticker";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { createTestCliContext } from "../test-support/cli-context";

function createBrokerInstance(): BrokerInstanceConfig {
  return {
    id: "demo-broker",
    brokerType: "demo",
    label: "Demo Broker",
    config: { apiKey: "demo-key" },
    enabled: true,
  };
}

function createBrokerInstanceWithId(id: string): BrokerInstanceConfig {
  return {
    id,
    brokerType: "demo",
    label: id,
    config: { apiKey: `${id}-key` },
    enabled: true,
  };
}

function createBrokerTicker(instanceId: string, accountId: string): TickerRecord {
  const portfolioId = `broker:${instanceId}:${accountId}`;
  return createTestTicker("AAPL", "Apple Inc.", {
    portfolios: [portfolioId],
    positions: [{
      portfolio: portfolioId,
      shares: 12,
      avgCost: 180,
      currency: "USD",
      broker: "demo",
      brokerInstanceId: instanceId,
      brokerAccountId: accountId,
    }],
    broker_contracts: [],
  });
}

function createDemoBroker(): BrokerAdapter {
  return {
    id: "demo",
    name: "Demo Broker",
    configSchema: [{ key: "apiKey", label: "API Key", type: "text", required: true }],
    validate: async () => true,
    listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
    importPositions: async () => [{
      ticker: "AAPL",
      exchange: "NASDAQ",
      shares: 12,
      avgCost: 180,
      currency: "USD",
      accountId: "ACC-1",
      name: "Apple Inc.",
      assetCategory: "STK",
    }],
  };
}

function createMultiAccountDemoBroker(): BrokerAdapter {
  return {
    id: "demo",
    name: "Demo Broker",
    configSchema: [{ key: "apiKey", label: "API Key", type: "text", required: true }],
    validate: async () => true,
    listAccounts: async (instance) => [{
      accountId: instance.id === "demo-work" ? "WORK" : "PERSONAL",
      name: instance.id === "demo-work" ? "Work" : "Personal",
      currency: "USD",
    }],
    importPositions: async (instance) => [{
      ticker: instance.id === "demo-work" ? "AAPL" : "MSFT",
      exchange: "NASDAQ",
      shares: instance.id === "demo-work" ? 12 : 8,
      avgCost: instance.id === "demo-work" ? 180 : 310,
      currency: "USD",
      accountId: instance.id === "demo-work" ? "WORK" : "PERSONAL",
      name: instance.id === "demo-work" ? "Apple Inc." : "Microsoft Corp.",
      assetCategory: "STK",
    }],
  };
}

describe("syncBrokerInstance", () => {
  test("preserves unavailable imported cost across serialization and replaces it only on source recovery", async () => {
    const repository = new JsonTickerRepository();
    let sourceCost: number | undefined;
    const adapter = createDemoBroker();
    adapter.importPositions = async () => [{ ticker: "AAPL", exchange: "NASDAQ", shares: 10,
      currency: "USD", accountId: "ACC-1", avgCost: sourceCost, unrealizedPnl: 200, marketValue: 1200 }];
    let config = { ...createDefaultConfig("/unused-import-cost"), portfolios: [], brokerInstances: [createBrokerInstance()] };
    for (const cost of [undefined, Number.NaN, Infinity, 0, 100, undefined]) {
      sourceCost = cost;
      const result = await syncBrokerInstance({ config, instanceId: "demo-broker", brokers: new Map([["demo", adapter]]), tickerRepository: repository });
      config = result.config as typeof config;
      const imported = result.tickers.get("AAPL")!;
      const reloaded = hydrateTickerMetadata(JSON.parse(JSON.stringify(imported.metadata)));
      expect(imported.metadata.positions[0]!.avgCost).toBe(Number.isFinite(cost) ? cost : undefined);
      expect(reloaded.positions[0]!.avgCost).toBe(Number.isFinite(cost) ? cost : undefined);
      expect(reloaded.positions[0]).toMatchObject({ shares: 10, unrealizedPnl: 200, marketValue: 1200 });
      expect(reloaded.positions).toHaveLength(1);
    }
  });

  test("retains supplied acquisition dates through resync, persistence, holding age and portfolio exports", async () => {
    const persistence = new AppPersistence(":memory:");
    const tickerRepository = new TickerRepository(persistence.tickers);
    const adapter = createDemoBroker();
    const portfolioId = "broker:demo-broker:ACC-1";
    const column = { id: "held", label: "HELD", width: 8, align: "right" as const };
    const now = Date.UTC(2026, 8, 12, 12);
    const context = { activeTab: portfolioId, baseCurrency: "USD", exchangeRates: new Map([["USD", 1]]), now };
    let config = { ...createDefaultConfig("/unused-acquisition-date"), portfolios: [], brokerInstances: [createBrokerInstance()] };
    try {
      for (const [shares, avgCost, dateAcquired, held] of [
        [10, 100, "2020-01-02", "6.7y"],
        [20, 50, "2020-01-02", "6.7y"],
        [20, 50, undefined, "—"],
        [20, 50, "not-a-date", "—"],
      ] as const) {
        adapter.importPositions = async () => [{ ticker: "AAPL", exchange: "NASDAQ", accountId: "ACC-1",
          shares, avgCost, currency: "USD", dateAcquired }];
        const synced = await syncBrokerInstance({ config, instanceId: "demo-broker", brokers: new Map([["demo", adapter]]), tickerRepository });
        config = synced.config as typeof config;
        const reloaded = (await tickerRepository.loadTicker("AAPL"))!;
        expect(reloaded.metadata.positions).toHaveLength(1);
        expect(reloaded.metadata.positions[0]).toMatchObject({ shares, avgCost });
        expect(reloaded.metadata.positions[0]!.dateAcquired).toBe(dateAcquired);
        expect(getColumnValue(column, reloaded, undefined, context).text).toBe(held);
        expect(getSortValue(column, reloaded, undefined, context)).toBe(held === "—" ? null : 2445);
        const cli = createTestCliContext({ config, store: tickerRepository,
          dataProvider: createTestDataProvider({ getQuote: async () => createTestQuote({ price: 60, previousClose: 60, lastUpdated: now }) }) }, { format: "json" });
        await showCollection(portfolioId, cli.context);
        expect((cli.printed[0]?.result.data as Array<{ dateAcquired: string | null }>)[0]!.dateAcquired).toBe(dateAcquired ?? null);
      }
    } finally {
      persistence.close();
    }
  });

  test("creates broker portfolios and imports positions into local tickers", async () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-instance"),
      portfolios: [],
      brokerInstances: [createBrokerInstance()],
    };
    const tickerRepository = new JsonTickerRepository();

    const result = await syncBrokerInstance({
      config,
      instanceId: "demo-broker",
      brokers: new Map([["demo", createDemoBroker()]]),
      tickerRepository,
    });

    expect(result.portfolioIds).toEqual(["broker:demo-broker:ACC-1"]);
    expect(result.config.portfolios).toEqual([
      {
        id: "broker:demo-broker:ACC-1",
        name: "Primary",
        currency: "USD",
        brokerId: "demo",
        brokerInstanceId: "demo-broker",
        brokerAccountId: "ACC-1",
        lastSyncedAt: expect.any(Number),
      },
    ]);
    expect(result.config.brokerInstances[0]?.lastSyncedAt).toEqual(expect.any(Number));
    expect(result.positions).toHaveLength(1);
    expect(result.addedTickers).toHaveLength(1);
    expect(result.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({
        portfolio: "broker:demo-broker:ACC-1",
        broker: "demo",
        shares: 12,
        brokerInstanceId: "demo-broker",
        brokerAccountId: "ACC-1",
      }),
    ]);
  });

  test("fails cleanly when the broker account cache cannot be persisted", async () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-persistence-error"),
      portfolios: [],
      brokerInstances: [createBrokerInstance()],
    };
    const tickerRepository = new JsonTickerRepository();

    await expect(syncBrokerInstance({
      config,
      instanceId: "demo-broker",
      brokers: new Map([["demo", createDemoBroker()]]),
      tickerRepository,
      resources: {
        get: () => null,
        list: () => [],
        set: () => { throw new Error("disk full"); },
        delete: () => {},
      } as any,
    })).rejects.toThrow("disk full");

    expect(await tickerRepository.loadTicker("AAPL")).toBeNull();
  });

  test("imports account and position data from one broker portfolio snapshot", async () => {
    const instance = createBrokerInstance();
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-snapshot"),
      portfolios: [],
      brokerInstances: [instance],
    };
    const tickerRepository = new JsonTickerRepository();
    const persistence = new AppPersistence(":memory:");
    let listAccountsCalled = false;
    let importPositionsCalled = false;
    const broker: BrokerAdapter = {
      ...createDemoBroker(),
      listAccounts: async () => {
        listAccountsCalled = true;
        return [];
      },
      importPositions: async () => {
        importPositionsCalled = true;
        return [];
      },
      importPortfolioSnapshot: async () => ({
        accounts: [{
          accountId: "ACC-1",
          name: "Snapshot Account",
          currency: "USD",
          netLiquidation: 125_000,
          grossPositionValue: 175_000,
          totalCashValue: -50_000,
        }],
        positions: [{
          ticker: "AAPL",
          exchange: "NASDAQ",
          shares: 12,
          avgCost: 180,
          currency: "USD",
          accountId: "ACC-1",
          name: "Apple Inc.",
          assetCategory: "STK",
        }],
      }),
    };

    try {
      const result = await syncBrokerInstance({
        config,
        instanceId: "demo-broker",
        brokers: new Map([["demo", broker]]),
        tickerRepository,
        resources: persistence.resources,
      });

      expect(listAccountsCalled).toBe(false);
      expect(importPositionsCalled).toBe(false);
      expect(result.brokerAccounts[0]?.netLiquidation).toBe(125_000);
      expect(result.positions).toHaveLength(1);
      expect(loadPersistedBrokerAccounts(persistence.resources, instance, broker)).toEqual(result.brokerAccounts);
    } finally {
      persistence.close();
    }
  });

  test("stages broker cache and ticker writes until a cancellation-safe commit", async () => {
    const instance = createBrokerInstance();
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-cancel"),
      portfolios: [],
      brokerInstances: [instance],
    };
    const tickerRepository = new JsonTickerRepository();
    const persistence = new AppPersistence(":memory:");
    const abortController = new AbortController();

    try {
      const result = await syncBrokerInstance({
        config,
        instanceId: instance.id,
        brokers: new Map([["demo", createDemoBroker()]]),
        tickerRepository,
        resources: persistence.resources,
        signal: abortController.signal,
        deferPersistence: true,
      });

      expect(await tickerRepository.loadAllTickers()).toEqual([]);
      expect(loadPersistedBrokerAccounts(persistence.resources, instance, createDemoBroker())).toBeNull();

      abortController.abort();
      await expect(result.commit()).rejects.toThrow("Broker import was cancelled.");

      expect(await tickerRepository.loadAllTickers()).toEqual([]);
      expect(loadPersistedBrokerAccounts(persistence.resources, instance, createDemoBroker())).toBeNull();
    } finally {
      persistence.close();
    }
  });

  test("preserves the last account snapshot when a broker portfolio snapshot fails", async () => {
    const instance = createBrokerInstance();
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-snapshot-failure"),
      portfolios: [],
      brokerInstances: [instance],
    };
    const tickerRepository = new JsonTickerRepository();
    const persistence = new AppPersistence(":memory:");
    const broker: BrokerAdapter = {
      ...createDemoBroker(),
      importPortfolioSnapshot: async () => {
        throw new Error("account snapshot unavailable");
      },
    };

    try {
      persistBrokerAccounts(persistence.resources, instance, broker, [{
        accountId: "ACC-1",
        name: "Stale Account",
        currency: "USD",
        netLiquidation: 99_000,
      }]);

      await expect(syncBrokerInstance({
        config,
        instanceId: "demo-broker",
        brokers: new Map([["demo", broker]]),
        tickerRepository,
        resources: persistence.resources,
      })).rejects.toThrow("account snapshot unavailable");

      expect(loadPersistedBrokerAccounts(persistence.resources, instance, broker)).toEqual([{
        accountId: "ACC-1",
        name: "Stale Account",
        currency: "USD",
        netLiquidation: 99_000,
      }]);
    } finally {
      persistence.close();
    }
  });

  test("preserves broker portfolios across sequential profile syncs", async () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-instances"),
      portfolios: [],
      brokerInstances: [
        createBrokerInstanceWithId("demo-work"),
        createBrokerInstanceWithId("demo-personal"),
      ],
    };
    const tickerRepository = new JsonTickerRepository();

    const result = await syncBrokerInstances({
      config,
      brokers: new Map([["demo", createMultiAccountDemoBroker()]]),
      tickerRepository,
      existingTickers: new Map(),
    });

    expect(result.errors).toEqual([]);
    expect(result.config.portfolios.map((portfolio) => portfolio.id)).toEqual([
      "broker:demo-work:WORK",
      "broker:demo-personal:PERSONAL",
    ]);
    expect(result.tickers.get("AAPL")?.metadata.positions[0]).toEqual(expect.objectContaining({
      portfolio: "broker:demo-work:WORK",
      brokerInstanceId: "demo-work",
      brokerAccountId: "WORK",
    }));
    expect(result.tickers.get("MSFT")?.metadata.positions[0]).toEqual(expect.objectContaining({
      portfolio: "broker:demo-personal:PERSONAL",
      brokerInstanceId: "demo-personal",
      brokerAccountId: "PERSONAL",
    }));
  });

  test("removes stale broker portfolios and positions for the same profile when account ids change", async () => {
    const stalePortfolioId = "broker:demo-broker:OLD-ALIAS";
    const currentPortfolioId = "broker:demo-broker:ACC-1";
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-stale-account"),
      portfolios: [
        { id: stalePortfolioId, name: "OLD-ALIAS", currency: "USD", brokerId: "demo", brokerInstanceId: "demo-broker", brokerAccountId: "OLD-ALIAS" },
      ],
      brokerInstances: [createBrokerInstance()],
    };
    const tickerRepository = new JsonTickerRepository(undefined, [createTestTicker("AAPL", "Apple Inc.", {
      portfolios: [stalePortfolioId],
      positions: [{
        portfolio: stalePortfolioId,
        shares: 10,
        avgCost: 170,
        currency: "USD",
        broker: "demo",
        brokerInstanceId: "demo-broker",
        brokerAccountId: "OLD-ALIAS",
      }],
      broker_contracts: [{ brokerId: "demo", brokerInstanceId: "demo-broker", conId: 123, symbol: "AAPL" }],
    })]);

    const result = await syncBrokerInstance({
      config,
      instanceId: "demo-broker",
      brokers: new Map([["demo", createDemoBroker()]]),
      tickerRepository,
    });

    expect(result.config.portfolios.map((portfolio) => portfolio.id)).toEqual([currentPortfolioId]);
    expect(result.tickers.get("AAPL")?.metadata.portfolios).toEqual([currentPortfolioId]);
    expect(result.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({
        portfolio: currentPortfolioId,
        brokerInstanceId: "demo-broker",
        brokerAccountId: "ACC-1",
        shares: 12,
      }),
    ]);
    expect(result.tickers.get("AAPL")?.metadata.broker_contracts).toEqual([]);
  });

  test("reuses a broker account portfolio across Flex and Gateway profiles", async () => {
    const flexInstance: BrokerInstanceConfig = {
      ...createBrokerInstanceWithId("demo-flex"),
      connectionMode: "flex",
      config: { connectionMode: "flex", apiKey: "flex-key" },
    };
    const gatewayInstance: BrokerInstanceConfig = {
      ...createBrokerInstanceWithId("demo-gateway"),
      connectionMode: "gateway",
      config: { connectionMode: "gateway", apiKey: "gateway-key" },
    };
    const flexPortfolioId = "broker:demo-flex:ACC-1";
    const staleGatewayPortfolioId = "broker:demo-gateway:ACC-1";
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-broker-shared-account"),
      portfolios: [
        { id: flexPortfolioId, name: "Primary", currency: "USD", brokerId: "demo", brokerInstanceId: "demo-flex", brokerAccountId: "ACC-1" },
        { id: staleGatewayPortfolioId, name: "Primary", currency: "USD", brokerId: "demo", brokerInstanceId: "demo-gateway", brokerAccountId: "ACC-1" },
      ],
      brokerInstances: [flexInstance, gatewayInstance],
    };
    const tickerRepository = new JsonTickerRepository(undefined, [createTestTicker("AAPL", "Apple Inc.", {
      portfolios: [flexPortfolioId, staleGatewayPortfolioId],
      positions: [
        {
          portfolio: flexPortfolioId,
          shares: 10,
          avgCost: 170,
          currency: "USD",
          broker: "demo",
          brokerInstanceId: "demo-flex",
          brokerAccountId: "ACC-1",
        },
        {
          portfolio: staleGatewayPortfolioId,
          shares: 11,
          avgCost: 171,
          currency: "USD",
          broker: "demo",
          brokerInstanceId: "demo-gateway",
          brokerAccountId: "ACC-1",
        },
      ],
      broker_contracts: [],
    })]);

    const result = await syncBrokerInstance({
      config,
      instanceId: "demo-gateway",
      brokers: new Map([["demo", createDemoBroker()]]),
      tickerRepository,
    });

    expect(result.portfolioIds).toEqual([flexPortfolioId]);
    expect(result.config.portfolios).toEqual([{
      id: flexPortfolioId,
      name: "Primary",
      currency: "USD",
      brokerId: "demo",
      brokerInstanceId: "demo-gateway",
      brokerAccountId: "ACC-1",
      lastSyncedAt: expect.any(Number),
    }]);
    expect(result.config.brokerInstances.find((instance) => instance.id === "demo-gateway")?.lastSyncedAt)
      .toEqual(expect.any(Number));
    expect(result.tickers.get("AAPL")?.metadata.portfolios).toEqual([flexPortfolioId]);
    expect(result.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({
        portfolio: flexPortfolioId,
        shares: 12,
        brokerInstanceId: "demo-gateway",
        brokerAccountId: "ACC-1",
      }),
    ]);
  });

  test("Gateway taking over a Flex portfolio keeps what Flex imported there, and Flex still syncs into it", async () => {
    const flex: BrokerInstanceConfig = {
      ...createBrokerInstanceWithId("demo-flex"),
      connectionMode: "flex",
      config: { connectionMode: "flex", apiKey: "flex-key" },
    };
    const gateway: BrokerInstanceConfig = {
      ...createBrokerInstanceWithId("demo-gateway"),
      connectionMode: "gateway",
      config: { connectionMode: "gateway", apiKey: "gateway-key" },
    };
    const portfolioId = "broker:demo-flex:ACC-1";
    const flexPosition = (ticker: string, shares: number): TickerRecord => createTestTicker(ticker, ticker, {
      portfolios: [portfolioId],
      positions: [{ portfolio: portfolioId, shares, avgCost: 100, currency: "USD", broker: "demo", brokerInstanceId: "demo-flex", brokerAccountId: "ACC-1" }],
      broker_contracts: [],
    });
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-sync-gateway-over-flex"),
      portfolios: [{ id: portfolioId, name: "Primary", currency: "USD", brokerId: "demo", brokerInstanceId: "demo-flex", brokerAccountId: "ACC-1" }],
      brokerInstances: [flex, gateway],
    };
    const tickerRepository = new JsonTickerRepository(undefined, [flexPosition("AAPL", 10), flexPosition("MSFT", 5)]);
    const flexBroker: BrokerAdapter = {
      ...createDemoBroker(),
      importPositions: async () => [
        { ticker: "AAPL", exchange: "NASDAQ", shares: 10, avgCost: 100, currency: "USD", accountId: "ACC-1" },
        { ticker: "MSFT", exchange: "NASDAQ", shares: 5, avgCost: 100, currency: "USD", accountId: "ACC-1" },
      ],
    };

    const gatewaySync = await syncBrokerInstance({
      config,
      instanceId: "demo-gateway",
      brokers: new Map([["demo", createDemoBroker()]]),
      tickerRepository,
    });

    expect(gatewaySync.config.portfolios).toEqual([expect.objectContaining({ id: portfolioId, brokerInstanceId: "demo-gateway" })]);
    expect(gatewaySync.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({ portfolio: portfolioId, shares: 12, brokerInstanceId: "demo-gateway" }),
    ]);
    // Gateway does not report MSFT; Flex's position stays, as it did before sign-in existed.
    expect(gatewaySync.tickers.get("MSFT")?.metadata.positions).toEqual([
      expect.objectContaining({ portfolio: portfolioId, shares: 5, brokerInstanceId: "demo-flex" }),
    ]);
    expect(gatewaySync.tickers.get("MSFT")?.metadata.portfolios).toEqual([portfolioId]);

    const flexSync = await syncBrokerInstance({
      config: gatewaySync.config,
      instanceId: "demo-flex",
      brokers: new Map([["demo", flexBroker]]),
      tickerRepository,
      existingTickers: gatewaySync.tickers,
    });

    expect(flexSync.portfolioIds).toEqual([portfolioId]);
    expect(flexSync.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({ portfolio: portfolioId, shares: 10, brokerInstanceId: "demo-flex" }),
    ]);
  });

  test("restores missing broker portfolios from existing ticker positions", () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-restore-broker-portfolios"),
      portfolios: [],
      brokerInstances: [createBrokerInstanceWithId("demo-work")],
    };

    const restored = restoreBrokerPortfoliosFromTickerPositions(config, [
      createBrokerTicker("demo-work", "WORK"),
    ]);

    expect(restored.portfolios).toEqual([{
      id: "broker:demo-work:WORK",
      name: "WORK",
      currency: "USD",
      brokerId: "demo",
      brokerInstanceId: "demo-work",
      brokerAccountId: "WORK",
    }]);
    expect(restoreBrokerPortfoliosFromTickerPositions(restored, [
      createBrokerTicker("demo-work", "WORK"),
    ])).toBe(restored);
  });
});

describe("switching an account to sign-in", () => {
  test("reuses and re-points the Flex portfolio, drops what Flex imported there, and survives removing Flex", async () => {
    const flex: BrokerInstanceConfig = {
      id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "flex", config: { connectionMode: "flex" }, enabled: true,
    };
    const signedIn: BrokerInstanceConfig = {
      id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, enabled: true,
    };
    const portfolioId = "broker:ibkr-flex:U123";
    const flexTicker = (ticker: string, shares: number): TickerRecord => ({
      metadata: {
        ticker, exchange: "NASDAQ", currency: "USD", name: ticker, portfolios: [portfolioId], watchlists: [],
        positions: [{ portfolio: portfolioId, shares, avgCost: 100, currency: "USD", broker: "ibkr", brokerInstanceId: "ibkr-flex", brokerAccountId: "U123" }],
        broker_contracts: [], custom: {}, tags: [],
      },
    });
    // Removing a profile saves the config, so it gets a directory of its own.
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-signed-in-reuse-"));
    const config = {
      ...createDefaultConfig(dataDir),
      portfolios: [{ id: portfolioId, name: "U123", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-flex", brokerAccountId: "U123" }],
      brokerInstances: [flex, signedIn],
    };
    const signedInAdapter = createSignedInBrokerAdapter({
      request: async <T,>() => ({
        accounts: [{ accountId: "U123", name: "U123", currency: "USD", source: "cloud" }],
        positions: [{ ticker: "AAPL", exchange: "NASDAQ", shares: 12, avgCost: 180, currency: "USD", accountId: "U123" }],
      }) as T,
      findBroker: () => null,
    });
    const brokers = new Map<string, BrokerAdapter>([["ibkr", createDemoBroker()], ["signed-in", signedInAdapter]]);
    const tickerRepository = new JsonTickerRepository(undefined, [flexTicker("AAPL", 10), flexTicker("MSFT", 5)]);

    const result = await syncBrokerInstance({ config, instanceId: "signed-in-ibkr", brokers, tickerRepository: tickerRepository as any });

    expect(result.portfolioIds).toEqual([portfolioId]);
    expect(result.config.portfolios).toEqual([expect.objectContaining({
      id: portfolioId, brokerId: "ibkr", brokerInstanceId: "signed-in-ibkr", brokerAccountId: "U123",
    })]);
    expect(result.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({ portfolio: portfolioId, shares: 12, brokerInstanceId: "signed-in-ibkr" }),
    ]);
    // Flex reported MSFT; the signed-in account does not, so it no longer sits in the portfolio.
    expect(result.tickers.get("MSFT")?.metadata).toMatchObject({ positions: [], portfolios: [] });

    const stateRef: { current: AppState } = { current: { ...createInitialState(result.config), tickers: result.tickers } };
    const pluginRegistry = {
      brokers,
      persistence: { resources: new MemoryResourceStore() },
      events: { emit() {} },
      bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
    } as unknown as PluginRegistry;
    bindPluginRegistryRuntimeAccess({
      dataProvider: createTestDataProvider(),
      dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
      importBrokerPositions: async () => {},
      marketData: {} as any,
      pluginRegistry,
      stateRef,
      tickerRepository: tickerRepository as any,
    });
    try {
      await pluginRegistry.removeBrokerInstance("ibkr-flex");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }

    expect(stateRef.current.config.brokerInstances.map((instance) => instance.id)).toEqual(["signed-in-ibkr"]);
    expect(stateRef.current.config.portfolios.map((portfolio) => portfolio.id)).toEqual([portfolioId]);
    expect(stateRef.current.tickers.get("AAPL")?.metadata.positions).toHaveLength(1);
  });

  test("a Flex sync after the switch leaves the signed-in portfolio alone", async () => {
    const flex: BrokerInstanceConfig = {
      id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "flex", config: { connectionMode: "flex" }, enabled: true,
    };
    const signedIn: BrokerInstanceConfig = {
      id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, enabled: true,
    };
    const portfolioId = "broker:ibkr-flex:U123";
    const portfolio = {
      id: portfolioId, name: "U123", currency: "USD", brokerId: "ibkr", brokerInstanceId: "signed-in-ibkr", brokerAccountId: "U123", lastSyncedAt: 5,
    };
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-signed-in-flex-resync"),
      portfolios: [portfolio],
      brokerInstances: [flex, signedIn],
    };
    const signedInTicker = createTestTicker("AAPL", "Apple Inc.", {
      portfolios: [portfolioId],
      positions: [{ portfolio: portfolioId, shares: 12, avgCost: 180, currency: "USD", broker: "signed-in", brokerInstanceId: "signed-in-ibkr", brokerAccountId: "U123" }],
      broker_contracts: [],
    });
    // The Flex statement is a day behind: fewer AAPL, and MSFT that has since been sold.
    const flexBroker: BrokerAdapter = {
      id: "ibkr",
      name: "IBKR",
      configSchema: [],
      validate: async () => true,
      listAccounts: async () => [{ accountId: "U123", name: "U123", currency: "USD" }],
      importPositions: async () => [
        { ticker: "AAPL", exchange: "NASDAQ", shares: 10, avgCost: 170, currency: "USD", accountId: "U123" },
        { ticker: "MSFT", exchange: "NASDAQ", shares: 5, avgCost: 300, currency: "USD", accountId: "U123" },
      ],
    };
    const tickerRepository = new JsonTickerRepository(undefined, [signedInTicker]);

    const result = await syncBrokerInstance({
      config,
      instanceId: "ibkr-flex",
      brokers: new Map<string, BrokerAdapter>([["ibkr", flexBroker], ["signed-in", createSignedInBrokerAdapter()]]),
      tickerRepository,
    });

    expect(result.portfolioIds).toEqual([]);
    expect(result.config.portfolios).toEqual([portfolio]);
    expect(result.tickers.get("AAPL")?.metadata.positions).toEqual([
      expect.objectContaining({ portfolio: portfolioId, shares: 12, brokerInstanceId: "signed-in-ibkr" }),
    ]);
    expect(result.tickers.has("MSFT")).toBe(false);
    expect((await tickerRepository.loadTicker("AAPL"))?.metadata.positions).toHaveLength(1);
  });
});

describe("removing one of an account's profiles", () => {
  const flex: BrokerInstanceConfig = {
    id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "flex", config: { connectionMode: "flex" }, enabled: true,
  };
  const gateway: BrokerInstanceConfig = {
    id: "ibkr-gateway", brokerType: "ibkr", label: "IBKR Gateway", connectionMode: "gateway", config: { connectionMode: "gateway" }, enabled: true,
  };
  const signedIn: BrokerInstanceConfig = {
    id: "signed-in-ibkr", brokerType: "signed-in", label: "Interactive Brokers", connectionMode: "ibkr", config: {}, enabled: true,
  };
  const portfolioId = "broker:ibkr-flex:U123";
  const heldBy = (instanceId: string): Portfolio => ({
    id: portfolioId, name: "U123", currency: "USD", brokerId: "ibkr", brokerInstanceId: instanceId, brokerAccountId: "U123",
  });
  const position = (ticker: string, instance: BrokerInstanceConfig): TickerRecord => createTestTicker(ticker, ticker, {
    portfolios: [portfolioId],
    positions: [{
      portfolio: portfolioId, shares: 10, avgCost: 100, currency: "USD", broker: instance.brokerType, brokerInstanceId: instance.id, brokerAccountId: "U123",
    }],
    broker_contracts: [],
  });

  async function remove(options: {
    instances: BrokerInstanceConfig[];
    portfolio: Portfolio;
    tickers: TickerRecord[];
    brokerAccounts?: Record<string, BrokerAccount[]>;
    instanceId: string;
  }) {
    // Removing a profile saves the config, so it gets a directory of its own.
    const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-remove-profile-"));
    const config: AppConfig = { ...createDefaultConfig(dataDir), portfolios: [options.portfolio], brokerInstances: options.instances };
    const tickers = new Map(options.tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
    const stateRef: { current: AppState } = {
      current: { ...createInitialState(config), tickers, brokerAccounts: options.brokerAccounts ?? {} },
    };
    const pluginRegistry = {
      brokers: new Map<string, BrokerAdapter>([["ibkr", createDemoBroker()], ["signed-in", createSignedInBrokerAdapter()]]),
      persistence: { resources: new MemoryResourceStore() },
      events: { emit() {} },
      bindHost(actions: object) { Object.assign(this, actions); return () => {}; },
    } as unknown as PluginRegistry;
    const synced: string[] = [];
    bindPluginRegistryRuntimeAccess({
      dataProvider: createTestDataProvider(),
      dispatch: (action: AppAction) => { stateRef.current = appReducer(stateRef.current, action); },
      importBrokerPositions: async (instanceId) => { synced.push(instanceId); },
      marketData: {} as any,
      pluginRegistry,
      stateRef,
      tickerRepository: new JsonTickerRepository(undefined, options.tickers) as any,
    });
    try {
      await pluginRegistry.removeBrokerInstance(options.instanceId);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
    return { state: stateRef.current, synced };
  }

  test("removing the signed-in profile hands the portfolio back to Flex", async () => {
    const { state, synced } = await remove({
      instances: [flex, signedIn],
      portfolio: heldBy("signed-in-ibkr"),
      tickers: [position("AAPL", signedIn)],
      brokerAccounts: { "ibkr-flex": [{ accountId: "U123", name: "U123", currency: "USD" }] },
      instanceId: "signed-in-ibkr",
    });

    expect(state.config.brokerInstances.map((instance) => instance.id)).toEqual(["ibkr-flex"]);
    expect(state.config.portfolios).toEqual([heldBy("ibkr-flex")]);
    expect(state.tickers.has("AAPL")).toBe(false);
    expect(synced).toEqual(["ibkr-flex"]);
  });

  test("removing Gateway hands the portfolio to the signed-in profile, keeping its positions", async () => {
    const { state, synced } = await remove({
      instances: [gateway, signedIn],
      portfolio: heldBy("ibkr-gateway"),
      tickers: [position("AAPL", gateway), position("MSFT", signedIn)],
      instanceId: "ibkr-gateway",
    });

    expect(state.config.portfolios).toEqual([heldBy("signed-in-ibkr")]);
    expect(state.tickers.has("AAPL")).toBe(false);
    expect(state.tickers.get("MSFT")?.metadata).toMatchObject({
      portfolios: [portfolioId],
      positions: [expect.objectContaining({ brokerInstanceId: "signed-in-ibkr" })],
    });
    expect(synced).toEqual(["signed-in-ibkr"]);
  });

  test("without a signed-in profile, the portfolio still goes with the profile that held it", async () => {
    const { state, synced } = await remove({
      instances: [flex, gateway],
      portfolio: heldBy("ibkr-gateway"),
      tickers: [position("AAPL", gateway), position("MSFT", flex)],
      brokerAccounts: { "ibkr-flex": [{ accountId: "U123", name: "U123", currency: "USD" }] },
      instanceId: "ibkr-gateway",
    });

    expect(state.config.portfolios).toEqual([]);
    expect(state.tickers.has("AAPL")).toBe(false);
    expect(state.tickers.get("MSFT")?.metadata.portfolios).toEqual([]);
    expect(synced).toEqual([]);
  });
});
