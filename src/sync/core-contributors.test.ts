import { describe, expect, test } from "bun:test";
import { createInitialState } from "../core/state/app/state";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../market-data/coordinator";
import { createTestDataProvider } from "../test-support/data-provider";
import { createDefaultConfig } from "../types/config";
import type { PricePoint } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import {
  __syncContributorInternalsForTests,
  coreCollectionsSyncContributor,
  coreConfigSyncContributor,
} from "./core-contributors";
import { setSyncedProfileAnalytics } from "./profile-analytics";
import { createTestTicker } from "../test-support/ticker";
import { createTestFinancials } from "../test-support/data-provider";

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
    const config = createDefaultConfig("/Users/ada/private-data");
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
        downloadPath: "/Users/ada/private-downloads",
      },
    };

    const state = createInitialState(config);
    const payload = await coreConfigSyncContributor.collect({ state });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("/Users/ada/private-data");
    expect(serialized).not.toContain("/Users/ada/private-downloads");
    expect(serialized).not.toContain("secret-api-key");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).toContain("Demo Broker");
  });

  // The pushed payload drops every token, so applying a pull as-is deleted
  // them here: an alert added on the laptop logged every plugin out on the
  // desktop, and Gloom Social asked for its token again.
  test("a pulled plugin config keeps this device's tokens and paths", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-secrets-test");
    config.pluginConfig = {
      "gloom-social": { apiUrl: "https://social.gloom.sh", token: "local-token" },
      "byok-ai": { apiKey: "local-key", accounts: { main: { model: "a", refreshToken: "local-refresh" } } },
      notes: { notesDirectory: "/Users/ada/notes" },
      alerts: { alerts: "[]" },
    };
    const lastSynced = await coreConfigSyncContributor.collect({ state: createInitialState(config) });

    const elsewhere = createDefaultConfig("/tmp/gloomberb-sync-secrets-elsewhere");
    elsewhere.pluginConfig = {
      "gloom-social": { apiUrl: "https://social.gloom.sh" },
      "byok-ai": { accounts: { main: { model: "b" } } },
      alerts: { alerts: "[{\"id\":\"a1\"}]" },
    };
    const pulled = await coreConfigSyncContributor.collect({ state: createInitialState(elsewhere) });

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, pulled, config, lastSynced);

    expect(merged?.pluginConfig).toEqual({
      "gloom-social": { apiUrl: "https://social.gloom.sh", token: "local-token" },
      "byok-ai": { apiKey: "local-key", accounts: { main: { model: "b", refreshToken: "local-refresh" } } },
      notes: { notesDirectory: "/Users/ada/notes" },
      alerts: { alerts: "[{\"id\":\"a1\"}]" },
    });
  });

  test("normalizes legacy built-in ownership in pulled config", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    const layouts = config.layouts.map((savedLayout) => savedLayout);

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      disabledPlugins: ["analytics", "kelly-sizer", "changelog"],
      pluginConfig: {
        analytics: { metric: "beta", shared: "legacy" },
        portfolio: { shared: "canonical" },
        help: { section: "shortcuts" },
      },
      layout: config.layout,
      layouts,
      activeLayoutIndex: config.activeLayoutIndex,
    });

    expect(merged?.disabledPlugins).toEqual(["portfolio"]);
    expect(merged?.pluginConfig).toEqual({
      portfolio: { metric: "beta", shared: "canonical" },
      application: { section: "shortcuts" },
    });
  });

  // Two signed-in clients used to hand each other their view on every poll:
  // the pull replaced live pane state with the other device's, the apply
  // pushed this device's back, and an open detail or a scrolled tab strip
  // reset every few seconds.
  test("a pulled layout keeps this device's session state", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-session-state-test");
    const localPaneState = { "jobs:home": { pluginState: { jobs: { "jobs:open": "NVDA" } } } };
    config.layouts = [{
      ...config.layouts[0]!,
      paneState: localPaneState,
      focusedPaneId: "jobs:home",
    }];
    const remoteLayout = {
      ...config.layout,
      instances: [...config.layout.instances, {
        instanceId: "help:remote",
        paneId: "help",
        binding: { kind: "none" as const },
      }],
    };

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      layout: remoteLayout,
      layouts: [{
        ...config.layouts[0]!,
        layout: remoteLayout,
        paneState: { "jobs:home": { pluginState: { jobs: { "jobs:open": null } } } },
        focusedPaneId: "help:remote",
      }],
      activeLayoutIndex: 0,
    });

    expect(merged?.layout).toEqual(remoteLayout);
    expect(merged?.layouts[0]?.layout).toEqual(remoteLayout);
    expect(merged?.layouts[0]?.paneState).toBe(localPaneState);
    expect(merged?.layouts[0]?.focusedPaneId).toBe("jobs:home");
  });

  test("the synced config payload carries no session state", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-session-payload-test");
    config.layouts = [{
      ...config.layouts[0]!,
      paneState: { "jobs:home": { cursorSymbol: "NVDA", pluginState: { jobs: { "jobs:open": "NVDA" } } } },
      focusedPaneId: "jobs:home",
      activePanel: "right",
    }];

    const payload = await coreConfigSyncContributor.collect({
      state: createInitialState(config),
    }) as any;

    expect(payload.layouts[0].layout).toBeDefined();
    expect(payload.layouts[0]).not.toHaveProperty("paneState");
    expect(payload.layouts[0]).not.toHaveProperty("focusedPaneId");
    expect(payload.layouts[0]).not.toHaveProperty("activePanel");
    expect(JSON.stringify(payload)).not.toContain("jobs:open");
  });

  test("emits legacy aliases for mixed-version config sync", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.disabledPlugins = ["portfolio"];
    config.pluginConfig = {
      portfolio: { "commonAssumptions:v1": { kellyFraction: 0.5 } },
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
    }
  });

  test("Macro round-trips through sync with apps from before it was split", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-group-test");
    const pull = (disabledPlugins: string[]) => (
      __syncContributorInternalsForTests.mergeConfigPayload(config, { disabledPlugins })?.disabledPlugins
    );
    const push = async (disabledPlugins: string[]) => (
      (await coreConfigSyncContributor.collect({ state: createInitialState({ ...config, disabledPlugins }) }) as any).disabledPlugins
    );
    const all = ["rates-macro", "credit", "earnings"];

    // An older app turns Macro off, under its own id or the one TV had inside it.
    expect(pull(["macro"])).toEqual(all);
    expect(pull(["macro-tv"])).toEqual(all);
    // A module that was once a plugin of its own stays with the successor holding it.
    expect(pull(["earnings-calendar"])).toEqual(["earnings"]);
    // Turning Macro off there over one successor already off here.
    expect(pull(["credit", "macro"])).toEqual(["credit", "rates-macro", "earnings"]);

    // All three off goes out as the one id the older app knows; fewer go out as themselves.
    expect(await push(all)).toEqual(["macro"]);
    expect(await push(["credit"])).toEqual(["credit"]);
    expect(await push(["credit", "earnings"])).toEqual(["credit", "earnings"]);
    // So turning Macro back on there drops `macro`, and all three come back.
    expect(pull((await push(all)).filter((pluginId: string) => pluginId !== "macro"))).toEqual([]);
  });

  test("Ticker Research round-trips through sync with apps from before it was split", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-ticker-research-test");
    const pull = (disabledPlugins: string[]) => (
      __syncContributorInternalsForTests.mergeConfigPayload(config, { disabledPlugins })?.disabledPlugins
    );
    const push = async (disabledPlugins: string[]) => (
      (await coreConfigSyncContributor.collect({ state: createInitialState({ ...config, disabledPlugins }) }) as any).disabledPlugins
    );
    const all = ["ticker-core", "options-volatility", "ownership", "filings", "alt-data", "quant", "credit", "earnings"];
    const allButCredit = all.filter((pluginId) => pluginId !== "credit");

    // An older app turns Ticker Research off, or one of the modules it once had as plugins.
    expect(pull(["ticker-research"])).toEqual(all);
    expect(pull(["options", "holders", "sec"])).toEqual(["options-volatility", "ownership", "filings"]);
    expect(pull(["macro", "ticker-research"])).toEqual(["rates-macro", "credit", "earnings", ...all.slice(0, 6)]);
    expect(await push(all)).toEqual(["ticker-research"]);
    expect(await push(["ownership"])).toEqual(["ownership"]);
    // Credit & Bonds turned back on: the older app sees Ticker Research on, the rest stay off here.
    expect(await push(allButCredit)).toEqual(allButCredit);
    expect(pull(await push(allButCredit))).toEqual(allButCredit);
    // And turning Ticker Research back on there brings all eight back.
    expect(pull((await push([...all, "news"])).filter((pluginId: string) => pluginId !== "ticker-research"))).toEqual(["news"]);
  });

  test("Market Overview round-trips through sync with apps from before it was split", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-market-overview-test");
    const pull = (disabledPlugins: string[]) => (
      __syncContributorInternalsForTests.mergeConfigPayload(config, { disabledPlugins })?.disabledPlugins
    );
    const push = async (disabledPlugins: string[]) => (
      (await coreConfigSyncContributor.collect({ state: createInitialState({ ...config, disabledPlugins }) }) as any).disabledPlugins
    );
    const all = ["global-markets", "screeners", "futures-commodities", "crypto", "alt-data", "quant"];

    expect(pull(["market-overview"])).toEqual(all);
    expect(pull(["world-indices", "market-movers"])).toEqual(["global-markets", "screeners"]);
    expect(pull(["quant", "market-overview"])).toEqual(["quant", ...all.slice(0, 5)]);
    expect(await push(all)).toEqual(["market-overview"]);
    expect(await push(["global-markets"])).toEqual(["global-markets"]);
    expect(pull((await push([...all, "news"])).filter((pluginId: string) => pluginId !== "market-overview"))).toEqual(["news"]);
  });

  test("preserves local broker identity when applying sanitized portfolios", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-broker-identity-test");
    config.portfolios = [{
      id: "broker:demo-live:ACCOUNT-1",
      name: "Primary",
      currency: "USD",
      brokerId: "demo",
      brokerInstanceId: "demo-live",
      brokerAccountId: "ACCOUNT-1",
      lastSyncedAt: 100,
    }];

    const collected = __syncContributorInternalsForTests.collectCoreConfigPayload(config) as {
      portfolios: Array<Record<string, unknown>>;
    };
    expect(collected.portfolios[0]).not.toHaveProperty("brokerInstanceId");
    expect(collected.portfolios[0]).not.toHaveProperty("brokerAccountId");

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      portfolios: [{
        id: "broker:demo-live:ACCOUNT-1",
        name: "Primary",
        currency: "USD",
        brokerId: "demo",
        lastSyncedAt: 200,
      }],
    });

    expect(merged?.portfolios).toEqual([{
      id: "broker:demo-live:ACCOUNT-1",
      name: "Primary",
      currency: "USD",
      brokerId: "demo",
      brokerInstanceId: "demo-live",
      brokerAccountId: "ACCOUNT-1",
      lastSyncedAt: 200,
    }]);
  });

  // Cash and targets are entered on one device; a pull that dropped them
  // erased them on every other device.
  test("a pulled portfolio keeps its cash and target weights", async () => {
    const elsewhere = createDefaultConfig("/tmp/gloomberb-sync-cash-elsewhere");
    elsewhere.portfolios = [{ id: "main", name: "Main", currency: "USD", cash: { amount: 25_000, currency: "EUR" }, targetWeights: { VTI: 70, CASH: 30 } }];
    const pushed = await coreConfigSyncContributor.collect({ state: createInitialState(elsewhere) });

    const config = createDefaultConfig("/tmp/gloomberb-sync-cash-here");
    config.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, pushed);

    expect(merged?.portfolios).toEqual(elsewhere.portfolios);
  });

  test("does not reintroduce older unlinked broker portfolios from cloud", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-broker-identity-test");
    config.portfolios = [
      {
        id: "main",
        name: "Main",
        currency: "USD",
      },
      {
        id: "broker:demo-live:ACCOUNT-1",
        name: "Primary",
        currency: "USD",
        brokerId: "demo",
        brokerInstanceId: "demo-live",
        brokerAccountId: "ACCOUNT-1",
        lastSyncedAt: 200,
      },
      {
        id: "broker:demo-live:ACCOUNT-2",
        name: "Secondary",
        currency: "USD",
        brokerId: "demo",
        brokerInstanceId: "demo-live",
        brokerAccountId: "ACCOUNT-2",
        lastSyncedAt: 200,
      },
    ];

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(config, {
      portfolios: [
        { id: "main", name: "Main", currency: "USD" },
        { id: "broker:demo-live:ACCOUNT-1", name: "Primary", currency: "USD", brokerId: "demo", lastSyncedAt: 200 },
        { id: "broker:demo-live:ACCOUNT-2", name: "Secondary", currency: "USD", brokerId: "demo", lastSyncedAt: 200 },
        { id: "broker:demo-old:ACCOUNT-1", name: "Primary", currency: "USD", brokerId: "demo", lastSyncedAt: 100 },
        { id: "broker:demo-old:ACCOUNT-2", name: "Secondary", currency: "USD", brokerId: "demo", lastSyncedAt: 100 },
        { id: "broker:demo-old:REMOVED", name: "Removed", currency: "USD", brokerId: "demo", lastSyncedAt: 100 },
        { id: "broker:demo-other:ACCOUNT-3", name: "Remote", currency: "USD", brokerId: "demo", lastSyncedAt: 300 },
      ],
    });

    expect(merged?.portfolios).toEqual([
      config.portfolios[0],
      config.portfolios[1],
      config.portfolios[2],
      {
        id: "broker:demo-other:ACCOUNT-3",
        name: "Remote",
        currency: "USD",
        brokerId: "demo",
        lastSyncedAt: 300,
      },
    ]);
  });

  test("merges broker profiles one by one once this device changed its own, so a removal on either side wins", () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-broker-merge-test");
    const flex = { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", config: { token: "secret" }, lastSyncedAt: 100 };
    const signedIn = { id: "signed-in-ibkr", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {}, lastSyncedAt: 100 };
    const robinhood = { id: "robinhood", brokerType: "robinhood", label: "Robinhood", config: {}, lastSyncedAt: 100 };
    const signedInPortfolio = {
      id: "broker:signed-in-ibkr:U1",
      name: "U1",
      currency: "USD",
      brokerId: "signed-in",
      brokerInstanceId: "signed-in-ibkr",
      brokerAccountId: "U1",
      lastSyncedAt: 100,
    };
    config.brokerInstances = [flex, signedIn, robinhood];
    config.portfolios = [...config.portfolios, signedInPortfolio];
    const lastSynced = __syncContributorInternalsForTests.collectCoreConfigPayload(config);

    // Here: Robinhood removed, IBKR synced again. Elsewhere: IBKR removed with
    // its portfolio, Robinhood renamed, Schwab added.
    const local = {
      ...config,
      brokerInstances: [flex, { ...signedIn, lastSyncedAt: 200 }],
      portfolios: config.portfolios.map((portfolio) => portfolio.brokerInstanceId ? { ...portfolio, lastSyncedAt: 200 } : portfolio),
    };
    const pulled = __syncContributorInternalsForTests.collectCoreConfigPayload({
      ...config,
      brokerInstances: [flex, { ...robinhood, label: "Robinhood IRA" }, { id: "schwab", brokerType: "schwab", label: "Schwab", config: {} }],
      portfolios: config.portfolios.filter((portfolio) => !portfolio.brokerInstanceId),
    });

    const merged = __syncContributorInternalsForTests.mergeConfigPayload(local, pulled, local, lastSynced);

    expect(merged?.brokerInstances.map((instance) => instance.id)).toEqual(["ibkr-flex", "schwab"]);
    expect(merged?.brokerInstances[0]?.config).toEqual({ token: "secret" });
    expect(merged?.portfolios.map((portfolio) => portfolio.id)).toEqual(["main"]);

    // An older build that changed its own profiles pushes its whole list,
    // which lacks any profile added since it last pulled: it removes nothing.
    const { brokerInstancesMergedById: _mergedById, ...fromOlderBuild } = pulled as Record<string, unknown>;
    const kept = __syncContributorInternalsForTests.mergeConfigPayload(local, fromOlderBuild, local, lastSynced);
    expect(kept?.brokerInstances.map((instance) => instance.id)).toEqual(["ibkr-flex", "signed-in-ibkr", "schwab"]);
    expect(kept?.portfolios.map((portfolio) => portfolio.id)).toEqual(["main", "broker:signed-in-ibkr:U1"]);
  });

  test("a profile removed elsewhere takes its positions here, and the tickers it alone held", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-broker-holdings-test");
    const signedIn = { id: "signed-in-ibkr", brokerType: "signed-in", label: "IBKR", connectionMode: "ibkr", config: {} };
    const account = { id: "broker:signed-in-ibkr:U1", name: "U1", currency: "USD", brokerId: "signed-in", brokerInstanceId: "signed-in-ibkr", brokerAccountId: "U1" };
    config.brokerInstances = [signedIn];
    config.portfolios = [...config.portfolios, account];
    // As another device's pull left them: the broker's identity stripped.
    const held = { portfolio: account.id, shares: 10, broker: "signed-in" };
    const state = createInitialState(config);
    state.tickers = new Map([
      ["AAPL", createTestTicker("AAPL", "Apple", { portfolios: [account.id], positions: [held] })],
      ["MSFT", createTestTicker("MSFT", "Microsoft", {
        portfolios: [account.id, "main"],
        positions: [{ ...held, brokerInstanceId: "signed-in-ibkr" }, { portfolio: "main", shares: 2, broker: "manual" }],
      })],
      ["NVDA", createTestTicker("NVDA", "NVIDIA", { portfolios: [account.id], watchlists: ["tech"], positions: [held] })],
    ]);
    const lastSynced = __syncContributorInternalsForTests.collectCoreConfigPayload(config);
    const pulled = __syncContributorInternalsForTests.collectCoreConfigPayload({
      ...config,
      brokerInstances: [],
      portfolios: config.portfolios.filter((portfolio) => portfolio.id !== account.id),
    });

    let current = state;
    const saved: string[] = [];
    const deleted: string[] = [];
    await coreConfigSyncContributor.apply?.(pulled, {
      baselinePayload: lastSynced,
      baselineState: state,
      state,
      getState: () => current,
      isCurrent: () => true,
      dispatch: (action: { type: string; config?: typeof config; tickers?: typeof state.tickers }) => {
        if (action.type === "SET_CONFIG") current = { ...current, config: action.config! };
        if (action.type === "SET_TICKERS") current = { ...current, tickers: action.tickers! };
      },
      tickerRepository: {
        saveTicker: async (record: TickerRecord) => { saved.push(record.metadata.ticker); },
        deleteTicker: async (symbol: string) => { deleted.push(symbol); },
      },
    } as unknown as Parameters<NonNullable<typeof coreConfigSyncContributor.apply>>[1]);

    expect(current.config.brokerInstances).toEqual([]);
    expect({ saved, deleted }).toEqual({ saved: ["MSFT", "NVDA"], deleted: ["AAPL"] });
    expect([...current.tickers.keys()]).toEqual(["MSFT", "NVDA"]);
    expect(current.tickers.get("MSFT")?.metadata).toMatchObject({ portfolios: ["main"], positions: [{ portfolio: "main", broker: "manual" }] });
    expect(current.tickers.get("NVDA")?.metadata).toMatchObject({ portfolios: [], positions: [], watchlists: ["tech"] });
  });

  test("a watchlist removed elsewhere leaves no id on tickers, pulled or local", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-watchlist-removal-test");
    config.watchlists = [{ id: "watchlist", name: "Watchlist" }, { id: "tech", name: "Tech" }];
    const position = { portfolio: "main", shares: 3, avgCost: 200, currency: "USD", broker: "manual" };
    const state = createInitialState(config);
    state.tickers = new Map([
      ["AAPL", createTestTicker("AAPL", "Apple", { portfolios: ["main"], watchlists: ["tech", "watchlist"], positions: [position] })],
      ["MSFT", createTestTicker("MSFT", "Microsoft", { watchlists: ["tech", "team:t1:w1"] })],
      ["NVDA", createTestTicker("NVDA", "NVIDIA", { watchlists: ["watchlist"] })],
    ]);
    const pulledConfig = __syncContributorInternalsForTests.collectCoreConfigPayload({
      ...config,
      watchlists: [{ id: "watchlist", name: "Watchlist" }],
    });
    // An older build deleted the list without clearing its tickers.
    const pulledCollections = { tickers: [state.tickers.get("AAPL")!.metadata] };

    let current = state;
    const saved: string[] = [];
    const context = {
      baselineState: state,
      state,
      getState: () => current,
      isCurrent: () => true,
      dispatch: (action: { type: string; config?: typeof config; tickers?: typeof state.tickers }) => {
        if (action.type === "SET_CONFIG") current = { ...current, config: action.config! };
        if (action.type === "SET_TICKERS") current = { ...current, tickers: action.tickers! };
      },
      tickerRepository: { saveTicker: async (record: TickerRecord) => { saved.push(record.metadata.ticker); } },
    };
    type ApplyContext = Parameters<NonNullable<typeof coreConfigSyncContributor.apply>>[1];
    await coreConfigSyncContributor.apply?.(pulledConfig, {
      ...context,
      baselinePayload: __syncContributorInternalsForTests.collectCoreConfigPayload(config),
    } as unknown as ApplyContext);
    await coreCollectionsSyncContributor.apply?.(pulledCollections, {
      ...context,
      state: current,
      baselinePayload: null,
    } as unknown as ApplyContext);

    expect(current.config.watchlists.map((watchlist) => watchlist.id)).toEqual(["watchlist"]);
    expect(saved).toEqual(["AAPL", "MSFT"]);
    expect(current.tickers.get("AAPL")?.metadata).toMatchObject({ portfolios: ["main"], watchlists: ["watchlist"], positions: [position] });
    expect(current.tickers.get("MSFT")?.metadata.watchlists).toEqual(["team:t1:w1"]);
    expect(current.tickers.get("NVDA")?.metadata.watchlists).toEqual(["watchlist"]);
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
    const ticker: TickerRecord = createTestTicker("NVDA", "NVIDIA", {
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
    });
    const state = createInitialState(config);
    state.tickers = new Map([["NVDA", ticker]]);
    state.financials = new Map([[
      "NVDA",
      createTestFinancials({
        quote: {
          symbol: "NVDA",
          price: 150,
          currency: "USD",
          change: 1,
          changePercent: 2,
          lastUpdated: 1,
        },
        fundamentals: { return1Y: 0.42 },
        priceHistory: [
          { date: new Date("2026-06-23T20:00:00.000Z"), close: 125 },
          { date: new Date("2026-06-30T20:00:00.000Z"), close: 149 },
        ],
      }),
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
    expect((payload as any).analyticsByPortfolio.main.oneYearReturn).toBeNull();

    const saved: TickerRecord[] = [];
    const sanitizedTickerPayload = { tickers: (payload as any).tickers };
    await coreCollectionsSyncContributor.apply?.(sanitizedTickerPayload, {
      baselinePayload: sanitizedTickerPayload,
      baselineState: state,
      state,
      getState: () => state,
      isCurrent: () => true,
      dispatch: () => {},
      tickerRepository: { saveTicker: async (record: TickerRecord) => { saved.push(record); } },
    } as unknown as Parameters<NonNullable<typeof coreCollectionsSyncContributor.apply>>[1]);

    expect(saved[0]?.metadata.positions[0]).toMatchObject({
      brokerInstanceId: "broker-id",
      brokerAccountId: "account-id",
      brokerContractId: 42,
    });
  });

  test("keeps a position written while the app was closed", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-position-test");
    config.portfolios = [{ id: "main", name: "Main", currency: "USD" }];
    const withoutPosition: TickerRecord = createTestTicker("NVDA", "NVIDIA", { portfolios: ["main"] });
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

  test("does not publish current holdings performance as account return or unsupported basket beta", async () => {
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
    const ticker = (symbol: string, portfolio: string): TickerRecord => (createTestTicker(symbol, symbol, {
      exchange: "TSE",
      currency: "JPY",
      portfolios: [portfolio],
      positions: [{
        portfolio,
        shares: 10,
        avgCost: 900,
        broker: "manual",
        currency: "JPY",
      }],
    }));
    const state = createInitialState(config);
    state.tickers = new Map([
      ["7203.T", ticker("7203.T", "main")],
      ["6758.T", ticker("6758.T", "broker:ibkr:U123")],
    ]);
    state.financials = new Map([
      ["7203.T", createTestFinancials({
        quote: { symbol: "7203.T", price: 1000, currency: "JPY", change: 0, changePercent: 0, lastUpdated: 1 },
        fundamentals: { return1Y: 0.1 },
        priceHistory: priceHistoryFromReturns([0.015, -0.0045, 0.018, 0.009, -0.006, 0.012, 0.0045, -0.003, 0.0105, 0.006, -0.0015]),
      })],
      ["6758.T", createTestFinancials({
        quote: { symbol: "6758.T", price: 1000, currency: "JPY", change: 0, changePercent: 0, lastUpdated: 1 },
        fundamentals: { return1Y: 0.2 },
        priceHistory: priceHistoryFromReturns([0.03, -0.009, 0.036, 0.018, -0.012, 0.024, 0.009, -0.006, 0.021, 0.012, -0.003]),
      })],
      ["SPY", createTestFinancials({
        quote: { symbol: "SPY", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 },
        priceHistory: priceHistoryFromReturns([0.01, -0.003, 0.012, 0.006, -0.004, 0.008, 0.003, -0.002, 0.007, 0.004, -0.001]),
      })],
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
    expect(payload.analyticsByPortfolio.main.oneYearReturn).toBeNull();
    expect(payload.analyticsByPortfolio.main.spyBeta).toBeNull();
    expect(payload.analyticsByPortfolio["broker:ibkr:U123"].oneYearReturn).toBeNull();
    expect(payload.analyticsByPortfolio["broker:ibkr:U123"].spyBeta).toBeNull();
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

    const mainTicker = state.tickers.get("7203.T")!;
    mainTicker.metadata.currency = "USD";
    mainTicker.metadata.positions[0]!.currency = "USD";
    state.financials.get("7203.T")!.quote!.currency = "USD";
    const supported = await coreCollectionsSyncContributor.collect({ state }) as any;
    expect(supported.analyticsByPortfolio.main.spyBeta).toBeCloseTo(1.5, 5);
    expect(supported.analyticsByPortfolio.main.oneYearReturn).toBeNull();

    const cleanBenchmark = state.financials.get("SPY")!.priceHistory!;
    const benchmarkEnd = cleanBenchmark.at(-1)!;
    state.financials.get("SPY")!.priceHistory = [...cleanBenchmark.slice(0, -1), { ...benchmarkEnd, high: benchmarkEnd.close - 1 }];
    setSyncedProfileAnalytics("main", { oneYearReturn: 0.25, spyBeta: 1.4 });
    const invalidBenchmark = await coreCollectionsSyncContributor.collect({ state }) as any;
    expect(invalidBenchmark.analyticsByPortfolio.main).toEqual({ oneYearReturn: 0.25, spyBeta: null, basis: "holdings" });
    state.financials.get("SPY")!.priceHistory = cleanBenchmark;
    const cleanHolding = state.financials.get("7203.T")!.priceHistory!;
    const holdingEnd = cleanHolding.at(-1)!;
    state.financials.get("7203.T")!.priceHistory = [...cleanHolding.slice(0, -1), { ...holdingEnd, low: holdingEnd.close + 1 }];
    const invalidHolding = await coreCollectionsSyncContributor.collect({ state }) as any;
    expect(invalidHolding.analyticsByPortfolio.main).toEqual({ oneYearReturn: null, spyBeta: null, basis: null });
    state.financials.get("7203.T")!.priceHistory = cleanHolding;
    setSyncedProfileAnalytics("main", null);
    const corrected = await coreCollectionsSyncContributor.collect({ state }) as any;
    expect(corrected.analyticsByPortfolio.main.spyBeta).toBeCloseTo(1.5, 5);

    mainTicker.metadata.positions[0]!.side = "short";
    const short = await coreCollectionsSyncContributor.collect({ state }) as any;
    expect(short.analyticsByPortfolio.main.spyBeta).toBeNull();
  });

  test("values holdings in a non-USD base currency with the loaded exchange rates", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-sync-test");
    config.baseCurrency = "EUR";
    config.portfolios = [{ id: "main", name: "Main", currency: "EUR" }];
    const state = createInitialState(config);
    state.tickers = new Map([["NVDA", {
      metadata: {
        ticker: "NVDA", exchange: "NASDAQ", currency: "USD", name: "NVIDIA",
        portfolios: ["main"], watchlists: [], custom: {}, tags: [],
        positions: [{ portfolio: "main", shares: 10, avgCost: 100, broker: "manual", currency: "USD" }],
      },
    }]]);
    const history = (returns: number[]) => ({
      quote: { symbol: "", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: 1 },
      priceHistory: priceHistoryFromReturns(returns), annualStatements: [], quarterlyStatements: [],
    });
    state.financials = new Map([
      ["NVDA", history([0.015, -0.0045, 0.018, 0.009, -0.006, 0.012, 0.0045, -0.003, 0.0105, 0.006, -0.0015])],
      ["SPY", history([0.01, -0.003, 0.012, 0.006, -0.004, 0.008, 0.003, -0.002, 0.007, 0.004, -0.001])],
    ]);
    const requested: string[] = [];
    setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
      getExchangeRate: async (currency) => { requested.push(currency); return 1.1; },
    })));
    try {
      const payload = await coreCollectionsSyncContributor.collect({ state }) as any;
      expect(payload.analyticsByPortfolio.main.spyBeta).toBeCloseTo(1.5, 5);
      expect(requested).toEqual(["EUR"]);
    } finally {
      setSharedMarketDataCoordinator(null);
    }
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
      basis: "holdings",
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
      basis: "holdings",
    });
  });
});
