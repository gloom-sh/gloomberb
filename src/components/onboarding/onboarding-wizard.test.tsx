import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { act } from "react";
import { apiClient } from "../../api-client";
import { type AppBrokerImportRuntime, useBrokerImportRuntime } from "../../app/runtime/broker-import";
import { syncBrokerInstance } from "../../brokers/sync-broker-instance";
import { testRender } from "../../renderers/opentui/test-utils";
import {
  AppProvider,
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import {
  createDefaultConfig,
  type AppConfig,
} from "../../types/config";
import type { TickerRecord } from "../../types/ticker";
import { EventBus } from "../../plugins/event-bus";
import type { PluginRegistry } from "../../plugins/registry";
import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import { ACCOUNT_CHOICE_IDS } from "../../plugins/builtin/cloud/auth-model";
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

async function emitKeypress(event: { name?: string; sequence?: string }) {
  await act(async () => {
    testSetup!.renderer.keyInput.emit("keypress", {
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      ...event,
    } as any);
    await testSetup!.renderOnce();
  });
}

async function waitForFrame(text: string, attempts = 40): Promise<string> {
  for (let index = 0; index < attempts; index += 1) {
    const frame = testSetup!.captureCharFrame();
    if (frame.includes(text)) return frame;
    await act(async () => {
      // Sleeping zero only drains the task queue. These steps wait on real
      // filesystem writes, so once the fast path has not settled the retries
      // need actual elapsed time; otherwise a loaded machine runs out of
      // attempts while the write is still in flight.
      await Bun.sleep(index < 5 ? 0 : 5);
      await testSetup!.renderOnce();
    });
  }
  throw new Error(`Timed out waiting for "${text}".`);
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup!.renderer.destroy());
    testSetup = undefined;
  }
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
  test("enters the real workspace task immediately after manual setup", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-"));
    const pluginRegistry = createPluginRegistry();
    testSetup = await testRender(
      <WizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
      />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).toContain("Make Gloomberb yours");
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("How do you want to start?");
    await emitKeypress({ name: "return", sequence: "\r" });

    const frame = await waitForFrame("Add one company you follow");
    expect(frame).toContain("Add one company you follow");
    expect(frame).toContain("AP");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "add-ticker",
      path: "manual",
      portfolioId: "main",
    });
  });

  test("requires portfolio setup before onboarding can be skipped", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-required-portfolio-"));
    const pluginRegistry = createPluginRegistry();
    let completionCount = 0;
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "portfolio" as const },
    };
    testSetup = await testRender(
      <WizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        onComplete={() => { completionCount += 1; }}
      />,
      { width: 80, height: 24 },
    );
    await testSetup.renderOnce();

    expect(testSetup.captureCharFrame()).not.toContain("Skip setup");
    await emitKeypress({ name: "f10" });
    expect(completionCount).toBe(0);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("portfolio");

    await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(testSetup.captureCharFrame()).not.toContain("Back");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("portfolio");

    await emitKeypress({ name: "return", sequence: "\r" });
    const frame = await waitForFrame("Add one company you follow");
    expect(frame).not.toContain("Skip setup");
    await emitKeypress({ name: "f10" });
    expect(completionCount).toBe(0);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("add-ticker");
  });

  test("opens research before Cloud after the expected AP save", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-actions-"));
    const pluginRegistry = createPluginRegistry();
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: {
        version: 1 as const,
        stage: "add-ticker" as const,
        path: "manual" as const,
        portfolioId: "main",
      },
    };
    testSetup = await testRender(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await act(async () => {
      pluginRegistry.events.emit("command-bar:portfolio-membership-persisted", {
        symbol: "MSFT",
        portfolioId: "other",
      });
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("Add one company you follow");

    await act(async () => {
      pluginRegistry.events.emit("command-bar:portfolio-membership-persisted", {
        symbol: "AAPL",
        portfolioId: "main",
      });
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });
    const frame = await waitForFrame("Connect free Cloud");
    expect(frame).toContain("Connect free Cloud");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("research");
  });

  test("imports a broker portfolio before opening research", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-"));
    const tickerRepository = createTickerRepository();
    const broker: BrokerAdapter = {
      id: "demo",
      name: "Demo Broker",
      configSchema: [{ key: "host", label: "Host", type: "text", required: true, defaultValue: "paper" }],
      validate: async () => true,
      listAccounts: async () => [{ accountId: "ACC-1", name: "Primary", currency: "USD" }],
      importPositions: async () => [{
        ticker: "AAPL",
        exchange: "NASDAQ",
        shares: 7,
        avgCost: 180,
        currency: "USD",
        accountId: "ACC-1",
        name: "Apple Inc.",
        assetCategory: "STK",
      }],
    };
    const pluginRegistry = createPluginRegistry({
      brokers: new Map([["demo", broker]]),
      tickerRepository,
    });
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "portfolio" as const },
    };
    testSetup = await testRender(
      <RuntimeWizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("Connect Demo Broker");
    await emitKeypress({ name: "return", sequence: "\r" });

    const frame = await waitForFrame("Connect free Cloud");
    expect(frame).toContain("Connect free Cloud");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "research",
      path: "broker",
      tickerSymbol: "AAPL",
      brokerName: "Demo Broker",
      positionsImported: 1,
    });
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker)).toContain("AAPL");
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
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "portfolio" as const },
    };

    testSetup = await testRender(
      <RuntimeWizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("Connect Delayed Broker");
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("Importing");

    await emitKeypress({ name: "escape", sequence: "\u001b" });
    await waitForFrame("How do you want to start?");

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
    expect(await tickerRepository.loadAllTickers()).toEqual([]);
    expect(resourceWrites).toBe(0);
  });

  test("defers Back after broker persistence begins until the commit completes", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-commit-"));
    let resolveFirstWrite: () => void = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
    let releaseSecondWrite: () => void = () => {};
    const secondWrite = new Promise<void>((resolve) => { releaseSecondWrite = resolve; });
    const tickerRepository = createTickerRepository([], async (ticker, persist) => {
      if (ticker.metadata.ticker === "AAPL") {
        persist();
        resolveFirstWrite();
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
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "portfolio" as const },
    };
    testSetup = await testRender(
      <RuntimeWizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("Connect Commit Broker");
    await emitKeypress({ name: "return", sequence: "\r" });
    await firstWriteStarted;

    await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(testSetup.captureCharFrame()).toContain("Importing");
    await emitKeypress({ name: "f10" });
    expect(testSetup.captureCharFrame()).toContain("Importing");
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker)).toEqual(["AAPL"]);

    await act(async () => {
      releaseSecondWrite();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });

    await waitForFrame("Connect free Cloud");
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker).sort()).toEqual(["AAPL", "MSFT"]);
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
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "portfolio" as const },
    };
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
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await emitKeypress({ name: "down", sequence: "\u001b[B" });
    await emitKeypress({ name: "return", sequence: "\r" });
    await waitForFrame("Connect Finalizing Broker");
    await emitKeypress({ name: "return", sequence: "\r" });
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

  test("waits for email verification before offering Pro", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-verify-"));
    const originalGetSession = apiClient.getSession;
    let resolveSession!: (user: Awaited<ReturnType<typeof apiClient.getSession>>) => void;
    apiClient.getSession = () => new Promise((resolve) => { resolveSession = resolve; });
    try {
      testSetup = await testRender(<WizardHarness config={{
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: { version: 1, stage: "verify", accountStatus: "signed-in" },
      }} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 30 });
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("Check your email");
      expect(capturedConfig?.onboardingProgress?.stage).toBe("verify");
      apiClient.setSessionToken("verification-test-session");
      apiClient.restoreCachedUser({ id: "verified-user", email: "research@example.com", emailVerified: true, plan: "free" });
      await act(async () => {
        resolveSession(apiClient.getCurrentUser());
        await Bun.sleep(0);
        await testSetup!.renderOnce();
      });
      await waitForFrame("Start 7-day free trial");
      expect(capturedConfig?.onboardingProgress?.stage).toBe("upgrade");
    } finally { apiClient.getSession = originalGetSession; }
  });

  test("loads the current Cloud price on the Pro step", async () => {
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
        { width: 100, height: 30 },
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

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("$49/mo");
      expect(frame).not.toContain("$29/mo");
    } finally {
      apiClient.getCloudPricing = getCloudPricing;
    }
  });

  test("Not now skips Pro and moves directly to ready", async () => {
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
    testSetup = await testRender(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    // qr, signup, login, then "Not now".
    for (let index = 0; index < ACCOUNT_CHOICE_IDS.indexOf("skip"); index += 1) {
      await emitKeypress({ name: "down", sequence: "\u001b[B" });
    }
    await emitKeypress({ name: "return", sequence: "\r" });

    const frame = await waitForFrame("Your workspace is ready");
    expect(frame).not.toContain("GLOOM CLOUD PRO");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "ready",
      accountStatus: "skipped",
    });
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
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await emitKeypress({ name: "escape", sequence: "\u001b" });

    const frame = await waitForFrame("Connected");
    expect(frame).not.toContain("Sign up free");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("account");
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
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Your workspace is ready");

    await emitKeypress({ name: "return", sequence: "\r" });
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

  test("global dismissal wins over an onboarding progress save", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-dismiss-"));
    const pluginRegistry = createPluginRegistry();
    let completed: AppConfig | null = null;
    testSetup = await testRender(
      <WizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        onComplete={(nextConfig) => { completed = nextConfig; }}
      />,
      { width: 100, height: 30 },
    );
    await testSetup.renderOnce();

    await act(async () => {
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
