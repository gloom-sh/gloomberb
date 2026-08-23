import { describe, expect, test } from "bun:test";
import { createInitialState } from "../core/state/app/state";
import { createDefaultConfig } from "../types/config";
import type { PricePoint } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import {
  __syncContributorInternalsForTests,
  coreCollectionsSyncContributor,
  coreConfigSyncContributor,
} from "./core-contributors";
import { setSyncedProfileAnalytics } from "./profile-analytics";

describe("core sync contributors", () => {
  function priceHistoryFromReturns(returns: number[]): PricePoint[] {
    let close = 100;
    return [
      { date: new Date("2026-06-01T20:00:00.000Z"), close },
      ...returns.map((value, index) => {
        close *= 1 + value;
        return {
          date: new Date(Date.UTC(2026, 5, index + 2, 20)),
          close,
        };
      }),
    ];
  }

  test("redacts local paths and credential-like config keys", async () => {
    const config = createDefaultConfig("/Users/vince/private-data");
    config.brokerInstances = [{
      id: "broker-1",
      brokerType: "demo",
      label: "Demo Broker",
      config: {
        apiKey: "secret-api-key",
        password: "secret-password",
      },
    }];
    config.pluginConfig = {
      "demo-plugin": {
        theme: "dark",
        token: "secret-token",
        downloadPath: "/Users/vince/private-downloads",
      },
    };

    const state = createInitialState(config);
    const payload = await coreConfigSyncContributor.collect({ state });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("/Users/vince/private-data");
    expect(serialized).not.toContain("/Users/vince/private-downloads");
    expect(serialized).not.toContain("secret-api-key");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).toContain("Demo Broker");
  });

  test("normalizes legacy built-in ownership in pulled config", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    const layouts = config.layouts.map((savedLayout, index) => index === 0
      ? {
        ...savedLayout,
        paneState: {
          "portfolio-list:main": {
            pluginState: {
              analytics: { metric: "beta", shared: "legacy" },
              portfolio: { shared: "canonical" },
            },
          },
        },
      }
      : savedLayout);

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      disabledPlugins: ["analytics", "kelly-sizer", "changelog", "macro-tv"],
      pluginConfig: {
        analytics: { metric: "beta", shared: "legacy" },
        portfolio: { shared: "canonical" },
        help: { section: "shortcuts" },
      },
      layout: config.layout,
      layouts,
      activeLayoutIndex: config.activeLayoutIndex,
    });

    expect(merged?.disabledPlugins).toEqual(["portfolio", "macro"]);
    expect(merged?.pluginConfig).toEqual({
      portfolio: { metric: "beta", shared: "canonical" },
      application: { section: "shortcuts" },
    });
    expect(merged?.layouts[0]?.paneState?.["portfolio-list:main"]?.pluginState).toEqual({
      portfolio: { metric: "beta", shared: "canonical" },
    });
  });

  test("emits legacy aliases for mixed-version config sync", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.disabledPlugins = ["portfolio"];
    config.pluginConfig = {
      portfolio: { "commonAssumptions:v1": { kellyFraction: 0.5 } },
    };
    config.layouts[0] = {
      ...config.layouts[0]!,
      paneState: {
        "portfolio-list:main": {
          pluginState: {
            portfolio: { mode: "scenario" },
          },
        },
      },
    };

    const payload = await coreConfigSyncContributor.collect({
      state: createInitialState(config),
    }) as any;

    expect(payload.disabledPlugins).toEqual([
      "portfolio",
      "portfolio-list",
      "analytics",
      "kelly-sizer",
    ]);
    for (const pluginId of ["portfolio", "portfolio-list", "analytics", "kelly-sizer"]) {
      expect(payload.pluginConfig[pluginId]).toEqual(config.pluginConfig.portfolio);
      expect(
        payload.layouts[0].paneState["portfolio-list:main"].pluginState[pluginId],
      ).toEqual({ mode: "scenario" });
    }
  });

  test("keeps resumable onboarding local until the guide is complete", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.onboardingComplete = false;
    config.onboardingProgress = {
      version: 1,
      stage: "account",
      path: "manual",
      portfolioId: "main",
      tickerSymbol: "AAPL",
    };

    const payload = await coreConfigSyncContributor.collect({
      state: createInitialState(config),
    }) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("onboardingComplete");

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      onboardingComplete: true,
    });
    expect(merged?.onboardingComplete).toBe(false);
    expect(merged?.onboardingProgress).toEqual(config.onboardingProgress);
  });

  test("treats synced onboarding completion as a one-way signal", async () => {
    const completedConfig = createDefaultConfig("/tmp/gloomberb-sync-test");
    completedConfig.onboardingComplete = true;
    const completedPayload = await coreConfigSyncContributor.collect({
      state: createInitialState(completedConfig),
    }) as Record<string, unknown>;
    expect(completedPayload.onboardingComplete).toBe(true);

    const staleMerge = __syncContributorInternalsForTests.mergeConfigPayload(completedConfig, {
      onboardingComplete: false,
    });
    expect(staleMerge?.onboardingComplete).toBe(true);

    const incompleteConfig = createDefaultConfig("/tmp/gloomberb-sync-test");
    incompleteConfig.onboardingComplete = false;
    const incompletePayload = await coreConfigSyncContributor.collect({
      state: createInitialState(incompleteConfig),
    }) as Record<string, unknown>;
    expect(incompletePayload).not.toHaveProperty("onboardingComplete");
  });

  test("ignores malformed synced layout collections", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      layout: config.layout,
      layouts: null,
      activeLayoutIndex: 0,
    });

    expect(merged?.layout).toBe(config.layout);
    expect(merged?.layouts).toBe(config.layouts);
    expect(merged?.activeLayoutIndex).toBe(config.activeLayoutIndex);
  });

  test("syncs collection memberships and sanitized positions", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.portfolios = [{
      id: "main",
      name: "Main",
      currency: "USD",
      brokerAccountId: "account-id",
      brokerInstanceId: "broker-id",
    }];
    config.watchlists = [{ id: "ai", name: "AI" }];
    const ticker: TickerRecord = {
      metadata: {
        ticker: "NVDA",
        exchange: "NASDAQ",
        currency: "USD",
        name: "NVIDIA",
        portfolios: ["main"],
        watchlists: ["ai"],
        positions: [{
          portfolio: "main",
          shares: 10,
          avgCost: 100,
          broker: "manual",
          marketValue: 1500,
          brokerAccountId: "account-id",
          brokerInstanceId: "broker-id",
          brokerContractId: 42,
        }],
        custom: { secretToken: "hidden", note: "keep" },
        tags: ["semis"],
      },
    };
    const state = createInitialState(config);
    state.tickers = new Map([["NVDA", ticker]]);
    state.financials = new Map([[
      "NVDA",
      {
        quote: {
          symbol: "NVDA",
          price: 150,
          currency: "USD",
          change: 1,
          changePercent: 2,
          lastUpdated: 1,
        },
        fundamentals: { return1Y: 0.42 },
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: [
          { date: new Date("2026-06-23T20:00:00.000Z"), close: 125 },
          { date: new Date("2026-06-30T20:00:00.000Z"), close: 149 },
        ],
      },
    ]]);

    const payload = await coreCollectionsSyncContributor.collect({ state });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain("NVDA");
    expect(serialized).toContain("AI");
    expect(serialized).toContain("Main");
    expect(serialized).toContain("keep");
    expect(serialized).not.toContain("account-id");
    expect(serialized).not.toContain("broker-id");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("brokerContractId");
    expect((payload as any).baseCurrency).toBe("USD");
    expect((payload as any).exchangeRates).toEqual({ USD: 1 });
    expect((payload as any).tickers[0].quote.price).toBe(150);
    expect((payload as any).tickers[0].quote.weekReferencePrice).toBe(125);
    expect((payload as any).tickers[0].quote.weekChangePercent).toBe(20);
    expect((payload as any).analyticsByPortfolio.main.oneYearReturn).toBe(0.42);
  });

  test("keeps a position written while the app was closed", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-position-test");
    config.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
    const withoutPosition: TickerRecord = {
      metadata: {
        ticker: "NVDA",
        exchange: "NASDAQ",
        currency: "USD",
        name: "NVIDIA",
        portfolios: ["main"],
        watchlists: [],
        positions: [],
        custom: {},
        tags: [],
      },
    };
    const syncedState = createInitialState(config);
    syncedState.tickers = new Map([["NVDA", withoutPosition]]);
    const syncedPayload = await coreCollectionsSyncContributor.collect({ state: syncedState });

    // `gloomberb portfolio position set` wrote this straight to the database.
    const state = createInitialState(config);
    state.tickers = new Map([["NVDA", {
      metadata: {
        ...withoutPosition.metadata,
        positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "manual", currency: "USD" }],
      },
    }]]);

    const saved: TickerRecord[] = [];
    await coreCollectionsSyncContributor.apply?.(syncedPayload, {
      baselinePayload: syncedPayload,
      baselineState: state,
      state,
      getState: () => state,
      isCurrent: () => true,
      dispatch: () => {},
      tickerRepository: { saveTicker: async (record: TickerRecord) => { saved.push(record); } },
    } as unknown as Parameters<NonNullable<typeof coreCollectionsSyncContributor.apply>>[1]);

    expect(saved).toHaveLength(0);
    expect(state.tickers.get("NVDA")?.metadata.positions).toHaveLength(1);
  });

  test("syncs only public return and beta analytics", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.baseCurrency = "USD";
    config.portfolios = [
      { id: "main", name: "Main", currency: "USD" },
      {
        id: "broker:ibkr:U123",
        name: "U123",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr",
        brokerAccountId: "U123",
      },
    ];
    config.brokerInstances = [{
      id: "ibkr",
      brokerType: "ibkr",
      label: "IBKR",
      config: {},
      enabled: true,
    }];
    const ticker = (symbol: string, portfolio: string): TickerRecord => ({
      metadata: {
        ticker: symbol,
        exchange: "TSE",
        currency: "JPY",
        name: symbol,
        portfolios: [portfolio],
        watchlists: [],
        positions: [{
          portfolio,
          shares: 10,
          avgCost: 900,
          broker: "manual",
          currency: "JPY",
        }],
        custom: {},
        tags: [],
      },
    });
    const state = createInitialState(config);
    state.exchangeRates = new Map([["USD", 1], ["JPY", 0.0067]]);
    state.tickers = new Map([
      ["7203.T", ticker("7203.T", "main")],
      ["6758.T", ticker("6758.T", "broker:ibkr:U123")],
    ]);
    state.financials = new Map([
      ["7203.T", {
        quote: { symbol: "7203.T", price: 1000, currency: "JPY", change: 0, changePercent: 0, lastUpdated: 1 },
        fundamentals: { return1Y: 0.1 },
        priceHistory: priceHistoryFromReturns([0.015, -0.0045, 0.018, 0.009, -0.006, 0.012, 0.0045, -0.003, 0.0105, 0.006, -0.0015]),
        annualStatements: [],
        quarterlyStatements: [],
      }],
      ["6758.T", {
        quote: { symbol: "6758.T", price: 1000, currency: "JPY", change: 0, changePercent: 0, lastUpdated: 1 },
        fundamentals: { return1Y: 0.2 },
        priceHistory: priceHistoryFromReturns([0.03, -0.009, 0.036, 0.018, -0.012, 0.024, 0.009, -0.006, 0.021, 0.012, -0.003]),
        annualStatements: [],
        quarterlyStatements: [],
      }],
      ["SPY", {
        quote: { symbol: "SPY", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 },
        priceHistory: priceHistoryFromReturns([0.01, -0.003, 0.012, 0.006, -0.004, 0.008, 0.003, -0.002, 0.007, 0.004, -0.001]),
        annualStatements: [],
        quarterlyStatements: [],
      }],
    ]);
    state.brokerAccounts = {
      ibkr: [{
        accountId: "U123",
        name: "U123",
        currency: "USD",
        source: "flex",
        netLiquidation: 1_900_000,
        grossPositionValue: 2_320_000,
        dailyPnl: 12_345,
        unrealizedPnl: 456_789,
        updatedAt: 123,
      }],
    };

    const payload = await coreCollectionsSyncContributor.collect({ state }) as any;

    expect(payload.baseCurrency).toBe("USD");
    expect(payload.exchangeRates).toEqual({ USD: 1, JPY: 0.0067 });
    expect(payload.analyticsByPortfolio.main.oneYearReturn).toBe(0.1);
    expect(payload.analyticsByPortfolio.main.spyBeta).toBeCloseTo(1.5, 5);
    expect(payload.analyticsByPortfolio["broker:ibkr:U123"].oneYearReturn).toBe(0.2);
    expect(payload.analyticsByPortfolio["broker:ibkr:U123"].spyBeta).toBeCloseTo(3, 5);
    expect(payload.accountsByPortfolio).toEqual({
      "broker:ibkr:U123": {
        currency: "USD",
        netLiquidation: 1_900_000,
        dailyPnl: 12_345,
        unrealizedPnl: 456_789,
        updatedAt: 123,
      },
    });
    expect(payload.analyticsByPortfolio.main).not.toHaveProperty("marketValue");
    expect(payload.analyticsByPortfolio.main).not.toHaveProperty("holdingsCount");
    expect(payload.analyticsByPortfolio.main).not.toHaveProperty("currency");
    expect(payload.analyticsByPortfolio.main).not.toHaveProperty("sourceLabel");
  });

  test("redaction removes nested credential-shaped fields", () => {
    const sanitized = __syncContributorInternalsForTests.sanitizeUnknown({
      nested: {
        refreshToken: "nope",
        publicValue: "ok",
      },
    });

    expect(sanitized).toEqual({ nested: { publicValue: "ok" } });
  });

  test("uses preview-computed profile analytics without exposing values", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.portfolios = [{ id: "preview", name: "Preview", currency: "USD" }];
    const state = createInitialState(config);

    setSyncedProfileAnalytics("preview", { oneYearReturn: 0.25, spyBeta: 1.4 });
    const payload = await coreCollectionsSyncContributor.collect({ state }) as any;
    setSyncedProfileAnalytics("preview", null);

    expect(payload.analyticsByPortfolio.preview).toEqual({
      oneYearReturn: 0.25,
      spyBeta: 1.4,
    });
    expect(payload.analyticsByPortfolio.preview).not.toHaveProperty("marketValue");
  });

  test("preserves pulled profile analytics before local market data is ready", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
    const state = createInitialState(config);

    await coreCollectionsSyncContributor.apply?.({
      analyticsByPortfolio: {
        main: { oneYearReturn: 0.27, spyBeta: 1.1 },
      },
      tickers: [],
    }, {
      snapshot: {
        schemaVersion: 1,
        appId: "gloomberb",
        clientId: "test-client",
        createdAt: "2026-07-21T22:03:59.832Z",
        contributors: {},
      },
      baselineState: state,
      state,
      getState: () => state,
      isCurrent: () => true,
      dispatch: () => {},
      tickerRepository: {} as never,
    });

    const payload = await coreCollectionsSyncContributor.collect({ state }) as any;
    setSyncedProfileAnalytics("main", null);

    expect(payload.analyticsByPortfolio.main).toEqual({
      oneYearReturn: 0.27,
      spyBeta: 1.1,
    });
  });
});
