import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { act } from "react";
import { apiClient } from "../../api-client";
import { useBrokerImportRuntime, type AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { syncBrokerInstance } from "../../brokers/sync-broker-instance";
import { chatController } from "../../plugins/builtin/chat/controller";
import { EventBus } from "../../plugins/event-bus";
import type { PluginRegistry } from "../../plugins/registry";
import { emitKeypress as emitTuiKeypress, testRender, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import {
  AppProvider,
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import {
  createDefaultConfig,
  type AppConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { TickerRecord } from "../../types/ticker";
import { OnboardingWizard } from "./onboarding-wizard";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let tempDataDir: string | null = null;
let capturedConfig: AppConfig | null = null;
let capturedBrokerAccounts: Record<string, unknown> | null = null;

function createTickerRepository(
  initial: TickerRecord[] = [],
  onSave?: (ticker: TickerRecord, persist: () => void) => void | Promise<void>,
) {
  const tickers = new Map(initial.map((ticker) => [ticker.metadata.ticker, ticker] as const));
  return {
    async loadAllTickers() { return [...tickers.values()]; },
    async loadTicker(symbol: string) { return tickers.get(symbol) ?? null; },
    async saveTicker(ticker: TickerRecord) {
      const persist = () => { tickers.set(ticker.metadata.ticker, ticker); };
      await onSave?.(ticker, persist);
      if (!onSave) persist();
    },
    async createTicker(metadata: TickerRecord["metadata"]) {
      const ticker = { metadata };
      tickers.set(metadata.ticker, ticker);
      return ticker;
    },
    async deleteTicker(symbol: string) { tickers.delete(symbol); },
  };
}

const KNOWN_COMPANIES: Record<string, string> = {
  AAPL: "Apple Inc.",
  MSFT: "Microsoft Corp.",
  NVDA: "NVIDIA Corp.",
};

/** Exact-symbol search plus a flat $100 quote, enough to resolve and value a position. */
function createMarketData(): DataProvider {
  return {
    id: "test-market",
    async search(query: string) {
      const symbol = query.trim().toUpperCase();
      const name = KNOWN_COMPANIES[symbol];
      return name ? [{ providerId: "test-market", symbol, name, exchange: "NASDAQ", type: "STK", currency: "USD" }] : [];
    },
    async getQuote(symbol: string) {
      return { symbol, price: 100, currency: "USD", change: 1, changePercent: 1, lastUpdated: Date.now() };
    },
  } as unknown as DataProvider;
}

function createPluginRegistry(options: {
  brokers?: Map<string, BrokerAdapter>;
  tickerRepository?: ReturnType<typeof createTickerRepository>;
} = {}): PluginRegistry {
  return {
    allPlugins: new Map(),
    brokers: options.brokers ?? new Map(),
    paneTemplates: new Map(),
    events: new EventBus(),
    tickerRepository: options.tickerRepository ?? createTickerRepository(),
    marketData: createMarketData(),
    panes: new Map(["portfolio-list", "chart-composer", "news-top", "world-indices"].map((id) => [id, {}])),
    persistence: { resources: undefined },
    openCommandBar: () => {},
    navigateTicker: () => {},
  } as unknown as PluginRegistry;
}

function StateCapture() {
  capturedConfig = useAppSelector((state) => state.config);
  capturedBrokerAccounts = useAppSelector((state) => state.brokerAccounts);
  return null;
}

function WizardHarness({
  config,
  pluginRegistry,
  importBrokerPositions,
  onComplete = () => {},
}: {
  config: AppConfig;
  pluginRegistry: PluginRegistry;
  importBrokerPositions?: AppBrokerImportRuntime["importBrokerPositions"];
  onComplete?: (config: AppConfig) => void;
}) {
  const importer = importBrokerPositions ?? ((instanceId, tickerMap, options) => syncBrokerInstance({
    config: options?.config ?? config,
    instanceId,
    brokers: pluginRegistry.brokers,
    tickerRepository: pluginRegistry.tickerRepository,
    existingTickers: tickerMap,
    resources: pluginRegistry.persistence.resources,
    persistResolvedBrokerConfig: options?.persistResolvedBrokerConfig,
    signal: options?.signal,
  }));
  return (
    <AppProvider config={config}>
      <StateCapture />
      <OnboardingWizard
        pluginRegistry={pluginRegistry}
        importBrokerPositions={importer}
        onComplete={onComplete}
      />
    </AppProvider>
  );
}

function RuntimeOnboardingWizard({
  pluginRegistry,
  tickerRepository,
  onComplete = () => {},
}: {
  pluginRegistry: PluginRegistry;
  tickerRepository: ReturnType<typeof createTickerRepository>;
  onComplete?: (config: AppConfig) => void;
}) {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { importBrokerPositions } = useBrokerImportRuntime({
    dispatch,
    pluginRegistry,
    refreshQuote: () => {},
    stateRef,
    tickerRepository,
  });

  return (
    <OnboardingWizard
      pluginRegistry={pluginRegistry}
      importBrokerPositions={importBrokerPositions}
      onComplete={onComplete}
    />
  );
}

function RuntimeWizardHarness({
  config,
  pluginRegistry,
  tickerRepository,
  onComplete,
}: {
  config: AppConfig;
  pluginRegistry: PluginRegistry;
  tickerRepository: ReturnType<typeof createTickerRepository>;
  onComplete?: (config: AppConfig) => void;
}) {
  return (
    <AppProvider config={config}>
      <StateCapture />
      <RuntimeOnboardingWizard
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
        onComplete={onComplete}
      />
    </AppProvider>
  );
}

const emitKeypress = (event: TestKeyEvent) => emitTuiKeypress(testSetup!, event);
const pressEnter = () => emitKeypress({ name: "return", sequence: "\r" });
const pressEscape = () => emitKeypress({ name: "escape", sequence: "\u001b" });

async function typeText(text: string): Promise<void> {
  await act(async () => {
    await testSetup!.mockInput.typeText(text);
    await testSetup!.renderOnce();
  });
}

async function waitForFrame(text: string, attempts = 60): Promise<string> {
  for (let index = 0; index < attempts; index += 1) {
    const frame = testSetup!.captureCharFrame();
    if (frame.includes(text)) return frame;
    await act(async () => {
      // Sleeping zero only drains the task queue. These steps wait on real
      // filesystem writes and debounced lookups, so once the fast path has not
      // settled the retries need actual elapsed time.
      await Bun.sleep(index < 5 ? 0 : 10);
      await testSetup!.renderOnce();
    });
  }
  throw new Error(`Timed out waiting for "${text}".`);
}

let expectedPositionCount = 0;

/** Types a position through the three fields; blank shares follows the company only. */
async function addManualPosition(symbol: string, shares = "", avgCost = ""): Promise<void> {
  await typeText(symbol);
  await pressEnter();
  if (shares) await typeText(shares);
  await pressEnter();
  if (shares) {
    if (avgCost) await typeText(avgCost);
    await pressEnter();
  }
  // The typed symbol also sits in the ticker field, so wait for the row count.
  expectedPositionCount += 1;
  await waitForFrame(`Positions (${expectedPositionCount})`);
}

// Milestones and pricing go to the network; neither belongs in a render test.
const originalRecordResearchActivity = apiClient.recordResearchActivity;
const originalGetCloudPricing = apiClient.getCloudPricing;
beforeEach(() => {
  expectedPositionCount = 0;
  apiClient.recordResearchActivity = (async () => {}) as typeof apiClient.recordResearchActivity;
  apiClient.getCloudPricing = (async () => { throw new Error("offline"); }) as typeof apiClient.getCloudPricing;
});

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup!.renderer.destroy());
    testSetup = undefined;
  }
  apiClient.recordResearchActivity = originalRecordResearchActivity;
  apiClient.getCloudPricing = originalGetCloudPricing;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  capturedConfig = null;
  capturedBrokerAccounts = null;
  if (tempDataDir) {
    await rm(tempDataDir, { recursive: true, force: true });
    tempDataDir = null;
  }
});

describe("OnboardingWizard", () => {
  test("saves manual positions and opens the largest one as the research workspace", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-"));
    const tickerRepository = createTickerRepository();
    const pluginRegistry = createPluginRegistry({ tickerRepository });
    testSetup = await testRender(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    const first = testSetup.captureCharFrame();
    expect(first).toContain("What do you hold?");
    expect(first).not.toContain("Skip setup");
    expect(first).not.toContain("Recommended");

    await addManualPosition("MSFT", "4", "400");
    await addManualPosition("AAPL", "10", "180");
    const listed = testSetup.captureCharFrame();
    expect(listed).toContain("Positions (2)");
    expect(listed).toContain("10 @ 180");
    expect(listed).toContain("$1,000");

    await pressEscape();
    await pressEnter();

    const frame = await waitForFrame("Connect free Cloud");
    expect(frame).toContain("Built around AAPL");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "research",
      path: "manual",
      portfolioId: "main",
      tickerSymbol: "AAPL",
      positionsImported: 2,
    });
    const saved = await tickerRepository.loadTicker("AAPL");
    expect(saved?.metadata.positions).toEqual([
      { portfolio: "main", shares: 10, avgCost: 180, currency: "USD", broker: "manual" },
    ]);

    // The workspace behind the coach is the first-run layout, built around the
    // largest holding, with the watchlist seeded around what the user holds.
    const instances = capturedConfig?.layout.instances ?? [];
    expect(instances.find((instance) => instance.paneId === "chart-composer")?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
    expect(instances.filter((instance) => instance.paneId === "portfolio-list").map((instance) => instance.settings?.viewMode)).toEqual(["grid", "table"]);
    expect(capturedConfig?.layouts[0]?.layout).toEqual(capturedConfig?.layout);
    const watching = (await tickerRepository.loadAllTickers())
      .filter((ticker) => ticker.metadata.watchlists.includes("watchlist"))
      .map((ticker) => ticker.metadata.ticker);
    expect(watching).toEqual(["SPY", "QQQ", "NVDA", "AMZN", "TSLA"]);
  });

  test("a blank share count follows the company and prices a missing cost from the quote", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-follow-"));
    const tickerRepository = createTickerRepository();
    const pluginRegistry = createPluginRegistry({ tickerRepository });
    testSetup = await testRender(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await addManualPosition("NVDA");
    expect(testSetup.captureCharFrame()).toContain("following");
    expect((await tickerRepository.loadTicker("NVDA"))?.metadata).toMatchObject({ portfolios: ["main"], positions: [] });

    await addManualPosition("AAPL", "3");
    expect((await tickerRepository.loadTicker("AAPL"))?.metadata.positions).toEqual([
      { portfolio: "main", shares: 3, avgCost: 100, currency: "USD", broker: "manual" },
    ]);

    await pressEscape();
    await pressEnter();
    await waitForFrame("Built around AAPL");
  });

  test("cannot be skipped or continued before the first position", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-required-portfolio-"));
    const pluginRegistry = createPluginRegistry();
    let completionCount = 0;
    testSetup = await testRender(
      <WizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        onComplete={() => { completionCount += 1; }}
      />,
      { width: 80, height: 30 },
    );
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).not.toContain("Skip setup");
    await emitKeypress({ name: "f10" });
    expect(completionCount).toBe(0);
    await pressEscape();
    await pressEnter();
    await act(async () => { await Bun.sleep(20); await testSetup!.renderOnce(); });
    expect(completionCount).toBe(0);
    expect(capturedConfig?.onboardingProgress?.stage ?? "portfolio").toBe("portfolio");
    expect(testSetup.captureCharFrame()).toContain("What do you hold?");
  });

  test("imports a broker portfolio after the first manual position and opens its largest holding", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-"));
    const tickerRepository = createTickerRepository();
    const broker: BrokerAdapter = {
      id: "demo",
      name: "Demo Broker",
      configSchema: [{ key: "host", label: "Host", type: "text", required: true, defaultValue: "paper" }],
      validate: async () => true,
      listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
      importPositions: async () => [
        {
          ticker: "AAPL",
          exchange: "NASDAQ",
          shares: 7,
          avgCost: 180,
          currency: "USD",
          accountId: "ACC-1",
          name: "Apple Inc.",
          assetCategory: "STK",
        },
        {
          ticker: "MSFT",
          exchange: "NASDAQ",
          shares: 40,
          avgCost: 400,
          currency: "USD",
          accountId: "ACC-1",
          name: "Microsoft Corp.",
          assetCategory: "STK",
        },
      ],
    };
    const pluginRegistry = createPluginRegistry({
      brokers: new Map([["demo", broker]]),
      tickerRepository,
    });
    testSetup = await testRender(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    // The broker path only opens once a manual position exists.
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    expect(testSetup.captureCharFrame()).toContain("What do you hold?");
    await emitKeypress({ name: "a", sequence: "a" });

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Demo Broker");
    await pressEnter();

    const frame = await waitForFrame("Connect free Cloud");
    expect(frame).toContain("Built around MSFT");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "research",
      path: "broker",
      tickerSymbol: "MSFT",
      brokerName: "Demo Broker",
      positionsImported: 2,
    });
    const held = (await tickerRepository.loadAllTickers())
      .filter((ticker) => ticker.metadata.portfolios.length > 0)
      .map((ticker) => ticker.metadata.ticker)
      .sort();
    expect(held).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(capturedConfig?.layout.instances.find((instance) => instance.paneId === "chart-composer")?.binding).toEqual({ kind: "fixed", symbol: "MSFT" });
  });

  test("Back prevents a delayed broker import from committing config, accounts, or positions", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-cancel-"));
    const tickerRepository = createTickerRepository();
    let resolvePositions: (positions: BrokerPosition[]) => void = () => {};
    const positions = new Promise<BrokerPosition[]>((resolve) => {
      resolvePositions = resolve;
    });
    const broker: BrokerAdapter = {
      id: "delayed",
      name: "Delayed Broker",
      configSchema: [{ key: "apiKey", label: "API key", type: "text", required: true, defaultValue: "test-key" }],
      validate: async () => true,
      listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
      importPositions: async () => positions,
    };
    const pluginRegistry = createPluginRegistry({
      brokers: new Map([["delayed", broker]]),
      tickerRepository,
    });
    let resourceWrites = 0;
    pluginRegistry.persistence.resources = {
      get: () => undefined,
      list: () => [],
      set: () => { resourceWrites += 1; },
      delete: () => {},
    } as any;

    testSetup = await testRender(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Delayed Broker");
    await pressEnter();
    await waitForFrame("Importing");

    await pressEscape();
    await waitForFrame("What do you hold?");

    await act(async () => {
      resolvePositions([{
        ticker: "AAPL",
        exchange: "NASDAQ",
        shares: 7,
        avgCost: 180,
        currency: "USD",
        accountId: "ACC-1",
        name: "Apple Inc.",
        assetCategory: "STK",
      }]);
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    expect(capturedConfig?.brokerInstances).toEqual([]);
    expect(capturedBrokerAccounts).toEqual({});
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker)).toEqual(["NVDA"]);
    expect(resourceWrites).toBe(0);
  });

  test("defers Back after broker persistence begins until the commit completes", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-commit-"));
    let resolveFirstWrite: () => void = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
    let releaseSecondWrite: () => void = () => {};
    const secondWrite = new Promise<void>((resolve) => { releaseSecondWrite = resolve; });
    const tickerRepository = createTickerRepository([], async (ticker, persist) => {
      if (ticker.metadata.ticker !== "MSFT") {
        persist();
        if (ticker.metadata.ticker === "AAPL") resolveFirstWrite();
        return;
      }
      await secondWrite;
      persist();
    });
    const broker: BrokerAdapter = {
      id: "committing",
      name: "Commit Broker",
      configSchema: [{ key: "apiKey", label: "API key", type: "text", required: true, defaultValue: "test-key" }],
      validate: async () => true,
      listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
      importPositions: async () => [
        {
          ticker: "AAPL",
          exchange: "NASDAQ",
          shares: 7,
          avgCost: 180,
          currency: "USD",
          accountId: "ACC-1",
          name: "Apple Inc.",
          assetCategory: "STK",
        },
        {
          ticker: "MSFT",
          exchange: "NASDAQ",
          shares: 4,
          avgCost: 400,
          currency: "USD",
          accountId: "ACC-1",
          name: "Microsoft Corp.",
          assetCategory: "STK",
        },
      ],
    };
    const pluginRegistry = createPluginRegistry({
      brokers: new Map([["committing", broker]]),
      tickerRepository,
    });
    testSetup = await testRender(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Commit Broker");
    await pressEnter();
    await firstWriteStarted;

    await pressEscape();
    expect(testSetup.captureCharFrame()).toContain("Importing");
    await emitKeypress({ name: "f10" });
    expect(testSetup.captureCharFrame()).toContain("Importing");
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker).sort()).toEqual(["AAPL", "NVDA"]);

    await act(async () => {
      releaseSecondWrite();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    await waitForFrame("Connect free Cloud");
    const held = (await tickerRepository.loadAllTickers())
      .filter((ticker) => ticker.metadata.portfolios.length > 0)
      .map((ticker) => ticker.metadata.ticker)
      .sort();
    expect(held).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("research");
  });

  test("keeps Skip locked until broker onboarding finalization completes", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-finalize-"));
    let signalCommitEnded: () => void = () => {};
    const commitEnded = new Promise<void>((resolve) => { signalCommitEnded = resolve; });
    let releaseResult: () => void = () => {};
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    let completionCount = 0;
    const broker: BrokerAdapter = {
      id: "finalizing",
      name: "Finalizing Broker",
      configSchema: [{ key: "apiKey", label: "API key", type: "text", required: true, defaultValue: "test-key" }],
      validate: async () => true,
      importPositions: async () => [],
    };
    const pluginRegistry = createPluginRegistry({ brokers: new Map([["finalizing", broker]]) });
    const config = createDefaultConfig(tempDataDir);
    const importBrokerPositions: AppBrokerImportRuntime["importBrokerPositions"] = async (_instanceId, _tickerMap, options) => {
      options?.onCommitStart?.();
      options?.onCommitEnd?.();
      signalCommitEnded();
      await resultGate;
      const syncedConfig = options?.config ?? config;
      return {
        config: syncedConfig,
        tickers: new Map(),
        brokerAccounts: [],
        positions: [{
          ticker: "AAPL",
          exchange: "NASDAQ",
          shares: 7,
          avgCost: 180,
          currency: "USD",
          accountId: "ACC-1",
          name: "Apple Inc.",
          assetCategory: "STK",
        }],
        portfolioIds: ["main"],
        addedTickers: [],
        updatedTickers: [],
        commit: async () => {},
      };
    };

    testSetup = await testRender(
      <WizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        importBrokerPositions={importBrokerPositions}
        onComplete={() => { completionCount += 1; }}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Finalizing Broker");
    await pressEnter();
    await commitEnded;
    await waitForFrame("Importing");

    await emitKeypress({ name: "f10" });
    expect(testSetup.captureCharFrame()).toContain("Importing");
    expect(completionCount).toBe(0);

    await act(async () => {
      releaseResult();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    await waitForFrame("Connect free Cloud");
    expect(completionCount).toBe(0);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("research");
  });

  test("email sign-up goes straight to Pro without waiting for verification", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-signup-"));
    const originalSignUp = apiClient.signUp;
    const originalSendVerification = apiClient.sendVerification;
    const originalRefresh = chatController.refreshSession;
    const signUps: string[] = [];
    apiClient.signUp = (async (email: string) => {
      signUps.push(email);
      const user = { id: "new-user", email, emailVerified: false, plan: "free" as const };
      apiClient.restoreCachedUser(user);
      return user;
    }) as typeof apiClient.signUp;
    apiClient.sendVerification = (async () => {}) as typeof apiClient.sendVerification;
    chatController.refreshSession = (async () => null) as typeof chatController.refreshSession;
    try {
      const config = {
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: {
          version: 1 as const,
          stage: "account" as const,
          path: "manual" as const,
          portfolioId: "main",
          tickerSymbol: "AAPL",
        },
      };
      testSetup = await testRender(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await testSetup.renderOnce();
      const form = await waitForFrame("Email");
      expect(form).toContain("Connect Gloom Cloud");
      expect(form).not.toContain("Sign up free");

      await typeText("research@example.com");
      await pressEnter();
      await typeText("longenough1");
      await pressEnter();

      const frame = await waitForFrame("Start 7-day free trial");
      expect(frame).toContain("Real-time market data");
      expect(frame).not.toContain("Check your email");
      expect(signUps).toEqual(["research@example.com"]);
      expect(capturedConfig?.onboardingProgress).toMatchObject({ stage: "upgrade", accountStatus: "signed-in" });
    } finally {
      apiClient.signUp = originalSignUp;
      apiClient.sendVerification = originalSendVerification;
      chatController.refreshSession = originalRefresh;
    }
  });

  test("an existing email falls through to login with the same password", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-login-fallthrough-"));
    const originalSignUp = apiClient.signUp;
    const originalSignIn = apiClient.signIn;
    const originalRefresh = chatController.refreshSession;
    const calls: string[] = [];
    apiClient.signUp = (async () => {
      calls.push("signup");
      throw new Error("An account with this email already exists");
    }) as typeof apiClient.signUp;
    apiClient.signIn = (async (email: string) => {
      calls.push("login");
      const user = { id: "returning-user", email, emailVerified: true, plan: "free" as const };
      apiClient.restoreCachedUser(user);
      return user;
    }) as typeof apiClient.signIn;
    chatController.refreshSession = (async () => null) as typeof chatController.refreshSession;
    try {
      const config = {
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: { version: 1 as const, stage: "account" as const, path: "manual" as const, portfolioId: "main" },
      };
      testSetup = await testRender(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await testSetup.renderOnce();

      await waitForFrame("Email");
      await typeText("returning@example.com");
      await pressEnter();
      await typeText("longenough1");
      await pressEnter();

      await waitForFrame("Start 7-day free trial");
      expect(calls).toEqual(["signup", "login"]);
    } finally {
      apiClient.signUp = originalSignUp;
      apiClient.signIn = originalSignIn;
      chatController.refreshSession = originalRefresh;
    }
  });

  test("shows the founding price with its anchor on the Pro step", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-pro-price-"));
    const getCloudPricing = apiClient.getCloudPricing;
    let resolvePricing!: (pricing: Awaited<ReturnType<typeof apiClient.getCloudPricing>>) => void;
    apiClient.getCloudPricing = () => new Promise((resolve) => {
      resolvePricing = resolve;
    });

    try {
      const pluginRegistry = createPluginRegistry();
      const config = {
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: {
          version: 1 as const,
          stage: "upgrade" as const,
          accountStatus: "signed-in" as const,
        },
      };
      testSetup = await testRender(
        <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
        { width: 100, height: 32 },
      );
      await testSetup.renderOnce();
      await act(async () => {
        resolvePricing({
          currency: "usd",
          trialDays: 7,
          founding: true,
          monthly: { amount: 3900, anchorAmount: 4900 },
          yearly: { amount: 39000, anchorAmount: 49000 },
        });
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });

      const frame = await waitForFrame("$39/mo");
      expect(frame).toContain("$49/mo");
      expect(frame).toContain("Founding price");
      expect(frame).toContain("Yearly, 2 months free");
      expect(frame).toContain("MCP server");
      expect(frame).toContain("Ask Gloom");
      expect(frame).not.toContain("Gloomberb AI");
      expect(frame).not.toContain("coming soon");

      // Right arrow moves the billing toggle to yearly; the price follows.
      await emitKeypress({ name: "right", sequence: "\u001b[C" });
      const yearly = await waitForFrame("$390/yr");
      expect(yearly).toContain("$490/yr");
      expect(yearly).toContain("2 months free");
      expect(yearly).not.toContain("$39/mo");
    } finally {
      apiClient.getCloudPricing = getCloudPricing;
    }
  });

  test("the trial button opens checkout for the chosen billing interval", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-checkout-"));
    apiClient.setSessionToken("onboarding-checkout-session");
    apiClient.restoreCachedUser({ id: "user-2", email: "trial@example.com", emailVerified: false, plan: "free" });
    const originalCheckout = apiClient.createCloudCheckout;
    const checkouts: Array<{ returnTo?: string; interval: string }> = [];
    apiClient.createCloudCheckout = (async (returnTo?: string, interval: "month" | "year" = "month") => {
      checkouts.push({ returnTo, interval });
      return { url: `https://checkout.example/${interval}` };
    }) as typeof apiClient.createCloudCheckout;
    try {
      const config = {
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: { version: 1 as const, stage: "upgrade" as const, accountStatus: "signed-in" as const },
      };
      testSetup = await testRender(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await testSetup.renderOnce();
      await waitForFrame("Start 7-day free trial");

      await emitKeypress({ name: "right", sequence: "\u001b[C" });
      await pressEnter();
      for (let index = 0; index < 30 && checkouts.length === 0; index += 1) {
        await act(async () => {
          await Bun.sleep(5);
          await testSetup!.renderOnce();
        });
      }
      // Unverified accounts go straight to checkout too; the status bar keeps asking for the email.
      expect(checkouts).toEqual([{ returnTo: undefined, interval: "year" }]);
      expect(capturedConfig?.onboardingProgress?.checkoutOpenedAt).toBeTruthy();
    } finally {
      apiClient.createCloudCheckout = originalCheckout;
    }
  });

  test("skipping from the account step finishes onboarding without an account", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-cloud-skip-"));
    const pluginRegistry = createPluginRegistry();
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: {
        version: 1 as const,
        stage: "account" as const,
        path: "manual" as const,
        portfolioId: "main",
        tickerSymbol: "MSFT",
      },
    };
    let completed: AppConfig | null = null;
    testSetup = await testRender(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} onComplete={(next) => { completed = next; }} />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();
    const form = await waitForFrame("Email");
    expect(form).toContain("Skip setup");
    expect(form).toContain("b: sign in with the browser instead");

    await emitKeypress({ name: "f10" });
    for (let index = 0; index < 30 && !completed; index += 1) {
      await act(async () => {
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });
    }
    expect(completed?.onboardingComplete).toBe(true);
    expect(completed?.onboardingProgress).toBeUndefined();
  });

  test("returning from Pro shows the connected account instead of signup choices", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-pro-back-"));
    apiClient.setSessionToken("onboarding-test-session");
    apiClient.restoreCachedUser({
      id: "user-1",
      email: "investor@example.com",
      emailVerified: true,
      plan: "free",
    });
    const pluginRegistry = createPluginRegistry();
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: {
        version: 1 as const,
        stage: "upgrade" as const,
        accountStatus: "signed-in" as const,
      },
    };
    testSetup = await testRender(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await pressEscape();

    const frame = await waitForFrame("Connected");
    expect(frame).not.toContain("Connect Gloom Cloud");
    expect(frame).not.toContain("Password");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("account");
  });

  test("a saved verify stage resumes on the Pro step", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-legacy-verify-"));
    testSetup = await testRender(<WizardHarness config={{
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1, stage: "verify", accountStatus: "signed-in" },
    }} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Start 7-day free trial");
  });

  test("persists completion only from the ready step", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-complete-"));
    const pluginRegistry = createPluginRegistry();
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: {
        version: 1 as const,
        stage: "ready" as const,
        path: "manual" as const,
        portfolioId: "main",
        tickerSymbol: "AAPL",
      },
    };
    let completed: AppConfig | null = null;
    testSetup = await testRender(
      <WizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        onComplete={(nextConfig) => { completed = nextConfig; }}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Your workspace is ready");

    await pressEnter();
    for (let index = 0; index < 20 && !completed; index += 1) {
      await act(async () => {
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });
    }

    expect(completed).not.toBeNull();
    expect(completed?.onboardingComplete).toBe(true);
    expect(completed?.onboardingProgress).toBeUndefined();
  });

  test("finishing wins over an onboarding progress save queued in the same tick", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-dismiss-"));
    const pluginRegistry = createPluginRegistry();
    let completed: AppConfig | null = null;
    testSetup = await testRender(
      <WizardHarness
        config={{
          ...createDefaultConfig(tempDataDir),
          onboardingProgress: { version: 1, stage: "ready", accountStatus: "skipped", tickerSymbol: "AAPL" },
        }}
        pluginRegistry={pluginRegistry}
        onComplete={(nextConfig) => { completed = nextConfig; }}
      />,
      { width: 100, height: 32 },
    );
    await testSetup.renderOnce();

    await act(async () => {
      // Back queues a progress save; Start exploring must still finish.
      testSetup!.renderer.keyInput.emit("keypress", {
        name: "escape",
        sequence: "\u001b",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
      } as any);
      testSetup!.renderer.keyInput.emit("keypress", {
        name: "return",
        sequence: "\r",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
      } as any);
      await testSetup!.renderOnce();
    });

    for (let index = 0; index < 30 && !completed; index += 1) {
      await act(async () => {
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });
    }

    expect(completed?.onboardingComplete).toBe(true);
    expect(completed?.onboardingProgress).toBeUndefined();
  });
});
