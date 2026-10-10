import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { act, type ReactNode } from "react";
import { apiClient } from "../../api-client";
import { useBrokerImportRuntime, type AppBrokerImportRuntime } from "../../app/runtime/broker-import";
import { syncBrokerInstance } from "../../brokers/sync-broker-instance";
import type { AppTickerRepositoryPort } from "../../core/app-service-ports";
import { JsonTickerRepository } from "../../data/json-ticker-repository";
import { chatController } from "../../plugins/builtin/chat/controller";
import { resetCloudUpgradeGuardForTests } from "../../plugins/builtin/shared/cloud-upgrade";
import { EventBus } from "../../plugins/event-bus";
import { useShortcut } from "../../react/input";
import type { PluginRegistry } from "../../plugins/registry";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import {
  AppProvider,
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../state/app/context";
import { createPaneDiscoveryContext } from "../../cli/pane-functions/discovery";
import { uiBuiltinPlugins } from "../../plugins/catalog-ui";
import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import type { GloomPlugin } from "../../types/plugin";
import {
  createDefaultConfig,
  type AppConfig,
} from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import { OnboardingWizard } from "./onboarding-wizard";

const tui = createOpenTuiTestHarness();
let tempDataDir: string | null = null;
let capturedConfig: AppConfig | null = null;
let capturedBrokerAccounts: Record<string, unknown> | null = null;

const KNOWN_LISTINGS: Record<string, { symbol: string; name: string; exchange: string; currency: string }> = {
  AAPL: { symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", currency: "USD" },
  MSFT: { symbol: "MSFT", name: "Microsoft Corp.", exchange: "NASDAQ", currency: "USD" },
  NVDA: { symbol: "NVDA", name: "NVIDIA Corp.", exchange: "NASDAQ", currency: "USD" },
  "TTALO.HE": { symbol: "TTALO", name: "Terveystalo Oyj", exchange: "HEL", currency: "EUR" },
  // Neither search nor quote knows this listing's currency.
  BARE: { symbol: "BARE", name: "Bare Listing", exchange: "XETRA", currency: "" },
};

/** Exact-symbol search plus a flat 100 quote in the listing's currency, enough to resolve and value a position. */
function createMarketData(): DataProvider {
  return {
    id: "test-market",
    async search(query: string) {
      const listing = KNOWN_LISTINGS[query.trim().toUpperCase()];
      return listing ? [{ providerId: "test-market", ...listing, type: "STK" }] : [];
    },
    async getQuote(symbol: string) {
      const currency = Object.values(KNOWN_LISTINGS).find((listing) => listing.symbol === symbol)?.currency ?? "USD";
      return { symbol, price: 100, currency, change: 1, changePercent: 1, lastUpdated: Date.now() };
    },
  } as unknown as DataProvider;
}

function createPluginRegistry(options: {
  brokers?: Map<string, BrokerAdapter>;
  tickerRepository?: AppTickerRepositoryPort;
} = {}): PluginRegistry {
  return {
    allPlugins: new Map(),
    brokers: options.brokers ?? new Map(),
    paneTemplates: new Map(),
    events: new EventBus(),
    tickerRepository: options.tickerRepository ?? new JsonTickerRepository(),
    marketData: createMarketData(),
    panes: new Map(["portfolio-list", "chart-composer", "news-top", "world-indices"].map((id) => [id, {}])),
    persistence: { resources: undefined },
    openCommandBar: () => {},
    navigateTicker: () => {},
  } as unknown as PluginRegistry;
}

const startedPlugins: GloomPlugin[] = [];
afterAll(() => {
  for (const plugin of startedPlugins.splice(0).reverse()) plugin.dispose?.();
});

let builtInFunctions: Promise<Pick<PluginRegistry, "panes" | "paneTemplates">> | null = null;

/** A registry that also has the app's own functions, so desks build from the real ones. */
async function createDeskRegistry(tickerRepository: AppTickerRepositoryPort): Promise<PluginRegistry> {
  builtInFunctions ??= (async () => {
    const config = createDefaultConfig("/tmp/onboarding-desks");
    const { panes, paneTemplates, ...context } = createPaneDiscoveryContext({ getConfig: () => config });
    for (const plugin of uiBuiltinPlugins) {
      for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
      for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
      startedPlugins.push(plugin);
      await plugin.setup?.({ ...context, registerCommand: () => {} });
    }
    return { panes, paneTemplates } as Pick<PluginRegistry, "panes" | "paneTemplates">;
  })();
  return { ...createPluginRegistry({ tickerRepository }), ...await builtInFunctions } as PluginRegistry;
}

function StateCapture() {
  capturedConfig = useAppSelector((state) => state.config);
  capturedBrokerAccounts = useAppSelector((state) => state.brokerAccounts);
  return null;
}

/** Records the keys that reach it, like a pane or the shell beside the wizard. */
function KeyProbe({ seen }: { seen: string[] }) {
  useShortcut((event) => { seen.push(event.name ?? ""); }, { phase: "before", allowEditable: true });
  return null;
}

function WizardHarness({
  config,
  pluginRegistry,
  importBrokerPositions,
  onComplete = () => {},
  before,
  after,
}: {
  config: AppConfig;
  pluginRegistry: PluginRegistry;
  importBrokerPositions?: AppBrokerImportRuntime["importBrokerPositions"];
  onComplete?: (config: AppConfig) => void;
  /** Mounted ahead of the wizard, the way the shell is. */
  before?: ReactNode;
  /** Mounted after the wizard, the way the command bar and new panes are. */
  after?: ReactNode;
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
      {before}
      <OnboardingWizard
        pluginRegistry={pluginRegistry}
        importBrokerPositions={importer}
        onComplete={onComplete}
      />
      {after}
    </AppProvider>
  );
}

function RuntimeOnboardingWizard({
  pluginRegistry,
  tickerRepository,
  onComplete = () => {},
}: {
  pluginRegistry: PluginRegistry;
  tickerRepository: AppTickerRepositoryPort;
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
  tickerRepository: AppTickerRepositoryPort;
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

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event);
const pressEnter = () => emitKeypress({ name: "return", sequence: "\r" });
const pressEscape = () => emitKeypress({ name: "escape", sequence: "\u001b" });
const pressSpace = () => emitKeypress({ name: "space", sequence: " " });

async function typeText(text: string): Promise<void> {
  await act(async () => {
    await tui.setup().mockInput.typeText(text);
    await tui.setup().renderOnce();
  });
}

async function waitForFrame(text: string, attempts = 60): Promise<string> {
  for (let index = 0; index < attempts; index += 1) {
    const frame = tui.frame();
    if (frame.includes(text)) return frame;
    await act(async () => {
      // Sleeping zero only drains the task queue. These steps wait on real
      // filesystem writes and debounced lookups, so once the fast path has not
      // settled the retries need actual elapsed time.
      await Bun.sleep(index < 5 ? 0 : 10);
      await tui.setup().renderOnce();
    });
  }
  throw new Error(`Timed out waiting for "${text}".`);
}

/**
 * Waits for something the wizard finishes in the background: it saves the
 * config to disk before it completes, and that write takes as long as the
 * runner lets it, not a fixed number of ticks.
 */
async function waitUntil(condition: () => boolean, description: string, timeoutMs = 4_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (let step = 0; !condition(); step += 1) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${description}.\n${tui.frame()}`);
    await act(async () => {
      await Bun.sleep(step < 5 ? 0 : 10);
      await tui.setup().renderOnce();
    });
  }
}

let expectedPositionCount = 0;

/**
 * Types a position through the fields; blank shares follows the company only.
 * A currency replaces whatever the field was prefilled with.
 */
async function addManualPosition(symbol: string, shares = "", avgCost = "", currency?: string): Promise<void> {
  await typeText(symbol);
  await pressEnter();
  if (shares) await typeText(shares);
  await pressEnter();
  if (shares) {
    if (avgCost) await typeText(avgCost);
    await pressEnter();
    if (currency !== undefined) {
      for (let index = 0; index < 4; index += 1) await emitKeypress({ name: "backspace", sequence: "\x7f" });
      if (currency) await typeText(currency);
    }
    await pressEnter();
  }
  await waitForAddedPosition();
}

async function waitForAddedPosition(): Promise<void> {
  // The typed symbol also sits in the ticker field, so wait for the row count.
  expectedPositionCount += 1;
  await waitForFrame(`Positions (${expectedPositionCount})`);
  // The row lands before the add finishes; typing on would be lost.
  for (let attempt = 0; attempt < 60 && tui.frame().includes("adding..."); attempt += 1) {
    await act(async () => {
      await Bun.sleep(attempt < 5 ? 0 : 10);
      await tui.setup().renderOnce();
    });
  }
}

/** Leaves "What do you trade?" without a desk, which keeps today's first-run workspace. */
async function skipDesks(): Promise<void> {
  await waitForFrame("What do you trade?");
  await emitKeypress({ name: "s", sequence: "s" });
}

// Milestones and pricing go to the network; neither belongs in a render test.
const originalRecordResearchActivity = apiClient.recordResearchActivity;
const originalGetCloudPricing = apiClient.getCloudPricing;
const originalGetCloudAccountPlan = apiClient.getCloudAccountPlan;
beforeEach(() => {
  expectedPositionCount = 0;
  apiClient.recordResearchActivity = (async () => {}) as typeof apiClient.recordResearchActivity;
  apiClient.getCloudPricing = (async () => { throw new Error("offline"); }) as typeof apiClient.getCloudPricing;
  apiClient.getCloudAccountPlan = (async () => ({ trialAvailable: true })) as typeof apiClient.getCloudAccountPlan;
});

afterEach(async () => {
  apiClient.recordResearchActivity = originalRecordResearchActivity;
  apiClient.getCloudPricing = originalGetCloudPricing;
  apiClient.getCloudAccountPlan = originalGetCloudAccountPlan;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  resetCloudUpgradeGuardForTests();
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
    const tickerRepository = new JsonTickerRepository();
    const pluginRegistry = createPluginRegistry({ tickerRepository });
    await tui.render(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    const first = tui.frame();
    expect(first).toContain("What do you hold?");
    expect(first).not.toContain("Skip setup");
    expect(first).not.toContain("Recommended");

    await addManualPosition("MSFT", "4", "400");
    await addManualPosition("AAPL", "10", "180");
    const listed = tui.frame();
    expect(listed).toContain("Positions (2)");
    expect(listed).toContain("10 @ 180");
    expect(listed).toContain("$1,000");

    await pressEscape();
    await pressEnter();

    await skipDesks();
    const frame = await waitForFrame("Connect free Cloud");
    expect(frame).toContain("Built around AAPL");
    expect(capturedConfig?.onboardingProgress).toMatchObject({
      stage: "research",
      path: "manual",
      portfolioId: "main",
      tickerSymbol: "AAPL",
      positionsImported: 2,
      desks: [],
    });
    // Skipping the desks keeps today's tabs.
    expect(capturedConfig?.layouts.map((layout) => layout.name)).toEqual(["Home", "Monitor", "Macro"]);
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

  test("each position takes its listing's currency unless one is typed, and blank falls back to the portfolio's", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-currency-"));
    const tickerRepository = new JsonTickerRepository();
    const pluginRegistry = createPluginRegistry({ tickerRepository });
    await tui.render(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await typeText("TTALO.HE");
    expect(await waitForFrame("Terveystalo")).toMatch(/Currency\s+EUR/);
    for (const value of ["100", "7.5"]) {
      await pressEnter();
      await typeText(value);
    }
    await pressEnter();
    await pressEnter();
    await waitForAddedPosition();
    await addManualPosition("AAPL", "10", "180");
    await addManualPosition("MSFT", "2", "400", "eur");
    await addManualPosition("BARE", "5", "20", "");

    const positionOf = async (symbol: string) => (await tickerRepository.loadTicker(symbol))?.metadata.positions[0]?.currency;
    expect(await positionOf("TTALO")).toBe("EUR");
    expect(await positionOf("AAPL")).toBe("USD");
    expect(await positionOf("MSFT")).toBe("EUR");
    // Unknown is not dollars: it lands in the portfolio's currency, which the
    // first position set to EUR.
    expect(capturedConfig?.portfolios.find((portfolio) => portfolio.id === "main")?.currency).toBe("EUR");
    expect(await positionOf("BARE")).toBe("EUR");
    expect((await tickerRepository.loadTicker("BARE"))?.metadata.currency).toBe("");
  });

  test("a blank share count follows the company and prices a missing cost from the quote", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-follow-"));
    const tickerRepository = new JsonTickerRepository();
    const pluginRegistry = createPluginRegistry({ tickerRepository });
    await tui.render(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await addManualPosition("NVDA");
    expect(tui.frame()).toContain("following");
    expect((await tickerRepository.loadTicker("NVDA"))?.metadata).toMatchObject({ portfolios: ["main"], positions: [] });

    await addManualPosition("AAPL", "3");
    expect((await tickerRepository.loadTicker("AAPL"))?.metadata.positions).toEqual([
      { portfolio: "main", shares: 3, avgCost: 100, currency: "USD", broker: "manual" },
    ]);

    await pressEscape();
    await pressEnter();
    await skipDesks();
    await waitForFrame("Built around AAPL");
  });

  test("What do you trade? opens the ticked desks as tabs after Home, in the order they were ticked", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-desks-"));
    const pluginRegistry = await createDeskRegistry(new JsonTickerRepository());
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "desks" as const, path: "manual" as const, portfolioId: "main", tickerSymbol: "AAPL" },
    };
    await tui.render(<WizardHarness config={config} pluginRegistry={pluginRegistry} />, { width: 100, height: 32 });
    await tui.setup().renderOnce();
    const frame = tui.frame();
    expect(frame).toContain("What do you trade?");
    for (const label of ["Equities", "Options", "Futures & commodities", "Rates & credit", "FX & macro", "Active trading"]) {
      expect(frame).toContain(label);
    }

    // Continue waits for a desk.
    await pressEnter();
    await act(async () => { await Bun.sleep(20); await tui.setup().renderOnce(); });
    expect(capturedConfig?.onboardingProgress?.stage ?? "desks").toBe("desks");

    // Rates, then Equities, then FX & macro with the mouse; then Equities off again.
    for (let step = 0; step < 3; step += 1) await emitKeypress({ name: "j", sequence: "j" });
    await pressSpace();
    for (let step = 0; step < 3; step += 1) await emitKeypress({ name: "k", sequence: "k" });
    await pressSpace();
    await tui.clickFrameText("FX & macro");
    for (let step = 0; step < 4; step += 1) await emitKeypress({ name: "up", sequence: "\u001b[A" });
    await pressSpace();
    await pressEnter();

    expect(await waitForFrame("Built around AAPL")).toContain("Your desks are tabs at the bottom");
    expect(capturedConfig?.onboardingProgress).toMatchObject({ stage: "research", desks: ["rates", "fx"] });
    expect(capturedConfig?.layouts.map((layout) => layout.name)).toEqual(["Home", "Rates", "FX & Macro", "Monitor", "Macro"]);
    expect(capturedConfig?.activeLayoutIndex).toBe(0);
    expect(capturedConfig?.layouts[1]?.layout.instances.map((instance) => instance.paneId)).toEqual([
      "rate-path", "yield-curve", "money-markets", "cdx-board", "central-bank-rates",
    ]);
  });

  test("the first-run milestone that ends onboarding names the desks picked", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-desks-event-"));
    const sent: Array<{ event: string; desks?: readonly string[] }> = [];
    apiClient.recordResearchActivity = (async (payload) => { sent.push(payload); }) as typeof apiClient.recordResearchActivity;
    apiClient.setSessionToken("onboarding-desks-session");
    apiClient.restoreCachedUser({ id: "user-desks", email: "desks@example.com", emailVerified: true, plan: "free" });
    await tui.render(
      <WizardHarness
        config={{
          ...createDefaultConfig(tempDataDir),
          onboardingProgress: { version: 1, stage: "ready", accountStatus: "signed-in", tickerSymbol: "AAPL", desks: ["options", "active"] },
        }}
        pluginRegistry={createPluginRegistry()}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();
    await pressEnter();
    const completedEvent = () => sent.find((payload) => payload.event === "onboarding_completed");
    await waitUntil(() => completedEvent() !== undefined, "the onboarding_completed milestone");
    expect(completedEvent()?.desks).toEqual(["options", "active"]);
  });

  test("cannot be skipped or continued before the first position", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-required-portfolio-"));
    const pluginRegistry = createPluginRegistry();
    let completionCount = 0;
    await tui.render(
      <WizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        onComplete={() => { completionCount += 1; }}
      />,
      { width: 80, height: 30 },
    );
    await tui.setup().renderOnce();

    expect(tui.frame()).not.toContain("Skip setup");
    await emitKeypress({ name: "f10" });
    expect(completionCount).toBe(0);
    await pressEscape();
    await pressEnter();
    await act(async () => { await Bun.sleep(20); await tui.setup().renderOnce(); });
    expect(completionCount).toBe(0);
    expect(capturedConfig?.onboardingProgress?.stage ?? "portfolio").toBe("portfolio");
    expect(tui.frame()).toContain("What do you hold?");
  });

  test("imports a broker portfolio after the first manual position and opens its largest holding", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-broker-"));
    const tickerRepository = new JsonTickerRepository();
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
    await tui.render(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    // The broker path only opens once a manual position exists.
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    expect(tui.frame()).toContain("What do you hold?");
    await emitKeypress({ name: "a", sequence: "a" });

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Demo Broker");
    await pressEnter();

    await skipDesks();
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
    const tickerRepository = new JsonTickerRepository();
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

    await tui.render(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

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
      await tui.setup().renderOnce();
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
    const repository = new JsonTickerRepository();
    const tickerRepository: AppTickerRepositoryPort = {
      loadAllTickers: () => repository.loadAllTickers(),
      loadTicker: (symbol) => repository.loadTicker(symbol),
      createTicker: (metadata) => repository.createTicker(metadata),
      deleteTicker: (symbol) => repository.deleteTicker(symbol),
      async saveTicker(ticker) {
        if (ticker.metadata.ticker === "MSFT") await secondWrite;
        await repository.saveTicker(ticker);
        if (ticker.metadata.ticker === "AAPL") resolveFirstWrite();
      },
    };
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
    await tui.render(
      <RuntimeWizardHarness
        config={createDefaultConfig(tempDataDir)}
        pluginRegistry={pluginRegistry}
        tickerRepository={tickerRepository}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Commit Broker");
    await pressEnter();
    await firstWriteStarted;

    await pressEscape();
    expect(tui.frame()).toContain("Importing");
    await emitKeypress({ name: "f10" });
    expect(tui.frame()).toContain("Importing");
    expect((await tickerRepository.loadAllTickers()).map((ticker) => ticker.metadata.ticker).sort()).toEqual(["AAPL", "NVDA"]);

    await act(async () => {
      releaseSecondWrite();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    await skipDesks();
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

    await tui.render(
      <WizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        importBrokerPositions={importBrokerPositions}
        onComplete={() => { completionCount += 1; }}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await addManualPosition("NVDA", "1", "100");
    await pressEscape();
    await emitKeypress({ name: "b", sequence: "b" });
    await waitForFrame("Connect Finalizing Broker");
    await pressEnter();
    await commitEnded;
    await waitForFrame("Importing");

    await emitKeypress({ name: "f10" });
    expect(tui.frame()).toContain("Importing");
    expect(completionCount).toBe(0);

    await act(async () => {
      releaseResult();
      await Bun.sleep(0);
      await tui.setup().renderOnce();
    });

    await skipDesks();
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
      await tui.render(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await tui.setup().renderOnce();
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
      await tui.render(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await tui.setup().renderOnce();

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

  test("a fall-through login with the wrong password stays on the email and keeps the reason", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-login-mismatch-"));
    const originalSignUp = apiClient.signUp;
    const originalSignIn = apiClient.signIn;
    apiClient.signUp = (async () => {
      throw new Error("An account with this email already exists");
    }) as typeof apiClient.signUp;
    apiClient.signIn = (async () => {
      throw new Error("Invalid email or password");
    }) as typeof apiClient.signIn;
    try {
      const config = {
        ...createDefaultConfig(tempDataDir),
        onboardingProgress: { version: 1 as const, stage: "account" as const, path: "manual" as const, portfolioId: "main" },
      };
      await tui.render(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await tui.setup().renderOnce();

      await waitForFrame("Email");
      await typeText("returning@example.com");
      await pressEnter();
      await typeText("longenough1");
      await pressEnter();

      // Switching the form to login must not wipe the message that explains why.
      const frame = await waitForFrame("already has an account, and that password did");
      expect(frame).toContain("Enter the password for this account.");
      expect(frame).toContain("returning@example.com");
      expect(frame).not.toContain("*".repeat("longenough1".length));
    } finally {
      apiClient.signUp = originalSignUp;
      apiClient.signIn = originalSignIn;
    }
  });

  test("shows the Pro price on the Pro step", async () => {
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
      await tui.render(
        <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
        { width: 100, height: 32 },
      );
      await tui.setup().renderOnce();
      await act(async () => {
        resolvePricing({
          currency: "usd",
          trialDays: 7,
          monthly: { amount: 7000 },
          yearly: { amount: 63000 },
        });
        await Bun.sleep(0);
        await tui.setup().renderOnce();
      });

      // The offline fallback is also $70/mo, so wait on what only the
      // fetched pricing can say.
      const frame = await waitForFrame("Yearly, 3 months free");
      expect(frame).toContain("$70/mo");
      expect(frame).not.toContain("ounding");
      expect(frame).toContain("MCP server");
      expect(frame).toContain("Ask Gloom");
      expect(frame).not.toContain("Gloomberb AI");
      expect(frame).not.toContain("coming soon");

      // Right arrow moves the billing toggle to yearly; the price follows.
      await emitKeypress({ name: "right", sequence: "\u001b[C" });
      const yearly = await waitForFrame("$630/yr");
      expect(yearly).toContain("3 months free");
      expect(yearly).not.toContain("$70/mo");
    } finally {
      apiClient.getCloudPricing = getCloudPricing;
    }
  });

  test("the trial button opens one checkout for the chosen billing interval, however often Enter repeats", async () => {
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
      await tui.render(<WizardHarness config={config} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
      await tui.setup().renderOnce();
      await waitForFrame("Start 7-day free trial");

      await emitKeypress({ name: "right", sequence: "\u001b[C" });
      await pressEnter();
      await pressEnter();
      await pressEnter();
      const opened = () => checkouts.length > 0 && !!capturedConfig?.onboardingProgress?.checkoutOpenedAt;
      // A few frames past the first checkout, for any repeat to land.
      for (let index = 0, settled = 0; index < 40 && settled < 5; index += 1) {
        await act(async () => {
          await Bun.sleep(5);
          await tui.setup().renderOnce();
        });
        if (opened()) settled += 1;
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
    await tui.render(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} onComplete={(next) => { completed = next; }} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();
    const form = await waitForFrame("Email");
    expect(form).toContain("Skip setup");
    expect(form).toContain("b: sign in with the browser instead");

    await emitKeypress({ name: "f10" });
    await waitUntil(() => completed !== null, "onboarding to complete");
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
    await tui.render(
      <WizardHarness config={config} pluginRegistry={pluginRegistry} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await pressEscape();

    const frame = await waitForFrame("Connected");
    expect(frame).not.toContain("Connect Gloom Cloud");
    expect(frame).not.toContain("Password");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("account");
  });

  test("a saved verify stage resumes on the Pro step", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-legacy-verify-"));
    await tui.render(<WizardHarness config={{
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1, stage: "verify", accountStatus: "signed-in" },
    }} pluginRegistry={createPluginRegistry()} />, { width: 100, height: 32 });
    await tui.setup().renderOnce();
    await waitForFrame("Start 7-day free trial");
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
    await tui.render(
      <WizardHarness
        config={config}
        pluginRegistry={pluginRegistry}
        onComplete={(nextConfig) => { completed = nextConfig; }}
      />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("Your workspace is ready");

    await pressEnter();
    await waitUntil(() => completed !== null, "onboarding to complete");

    expect(completed).not.toBeNull();
    expect(completed?.onboardingComplete).toBe(true);
    expect(completed?.onboardingProgress).toBeUndefined();
  });

  test("finishing wins over an onboarding progress save queued in the same tick", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-dismiss-"));
    const pluginRegistry = createPluginRegistry();
    let completed: AppConfig | null = null;
    await tui.render(
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
    await tui.setup().renderOnce();

    // Back queues a progress save; Start exploring must still finish.
    await tui.emitKeypress([
      { name: "escape", sequence: "\u001b" },
      { name: "return", sequence: "\r" },
    ]);

    await waitUntil(() => completed !== null, "onboarding to complete");

    expect(completed?.onboardingComplete).toBe(true);
    expect(completed?.onboardingProgress).toBeUndefined();
  });
  test("the keyboard removes an added position once the fields let go", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-remove-"));
    const tickerRepository = new JsonTickerRepository();
    await tui.render(
      <WizardHarness config={createDefaultConfig(tempDataDir)} pluginRegistry={createPluginRegistry({ tickerRepository })} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();

    await addManualPosition("NVDA");
    await addManualPosition("AAPL");
    await pressEscape();
    // The cursor starts on the newest row; k moves it up to the first.
    await waitForFrame("Remove d");
    await emitKeypress({ name: "k", sequence: "k" });
    await emitKeypress({ name: "d", sequence: "d" });

    await waitForFrame("Positions (1)");
    expect((await tickerRepository.loadTicker("NVDA"))?.metadata.portfolios).toEqual([]);
    expect((await tickerRepository.loadTicker("AAPL"))?.metadata.portfolios).toEqual(["main"]);
  });

  test("the card keeps the keys it does not use from the workspace behind it", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-modal-keys-"));
    const reached: string[] = [];
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: { version: 1 as const, stage: "upgrade" as const, accountStatus: "signed-in" as const },
    };
    await tui.render(
      <WizardHarness config={config} pluginRegistry={createPluginRegistry()} before={<KeyProbe seen={reached} />} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();
    await waitForFrame("Start 7-day free trial");

    const press = (event: TestKeyEvent) => tui.emitKeypress(event, { trackPropagation: true });
    await press({ name: "tab", sequence: "\t" });
    await press({ name: "j", sequence: "j" });
    await press({ name: "q", sequence: "q" });
    await press({ name: "w", ctrl: true });
    expect(reached).toEqual([]);

    // Help is the way out: the card steps aside while it has focus.
    await press({ name: "?", sequence: "?" });
    expect(reached).toEqual(["?"]);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("upgrade");
  });

  test("the research coach leaves Enter to the workspace and takes the notification key", async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "gloomberb-onboarding-coach-keys-"));
    const reached: string[] = [];
    const config = {
      ...createDefaultConfig(tempDataDir),
      onboardingProgress: {
        version: 1 as const,
        stage: "research" as const,
        path: "manual" as const,
        portfolioId: "main",
        tickerSymbol: "AAPL",
      },
    };
    await tui.render(
      <WizardHarness config={config} pluginRegistry={createPluginRegistry()} after={<KeyProbe seen={reached} />} />,
      { width: 100, height: 32 },
    );
    await tui.setup().renderOnce();
    expect(tui.frame()).toMatch(/Connect free Cloud\s+Alt\+Enter/);

    // The command bar and panes mount after the wizard and still get Enter.
    await tui.emitKeypress({ name: "return", sequence: "\r" }, { trackPropagation: true });
    expect(reached).toEqual(["return"]);
    expect(capturedConfig?.onboardingProgress?.stage).toBe("research");

    await tui.emitKeypress({ name: "return", sequence: "\r", meta: true }, { trackPropagation: true });
    await waitForFrame("Connect Gloom Cloud");
    expect(capturedConfig?.onboardingProgress?.stage).toBe("account");
  });
});
