import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useEffect, useReducer, useState } from "react";
import { TestDialogProvider, testRender } from "../../../../renderers/opentui/test-utils";
import { PaneFooterBar, PaneFooterProvider } from "../../../../components/layout/pane/footer";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
  type PaneRuntimeState,
} from "../../../../state/app/context";
import { createDefaultConfig } from "../../../../types/config";
import type { Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createStatefulTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { Box } from "../../../../ui";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../../runtime";
import { getSharedMarketData, setSharedMarketDataForTests, setSharedRegistryForTests } from "../../../registry";
import { AI_SCREENER_PANE_STATE_KEY, AiScreenerPane } from "./pane";
import { createScreenerTab, EMPTY_PANE_STATE } from "./model";
import { setDetectedProviders, type AiProvider } from "../providers";
import { setAiRunHost, setAiRuntimeCatalog, type AiRunHost } from "../runner";

const PANE_ID = "ai-screener:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeRuntime(): PluginRuntimeAccess {
  return createStatefulTestPluginRuntime({
    getMarketData: () => getSharedMarketData() ?? null,
  });
}

function makeTicker(symbol: string, name: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name,
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}

function makeFinancials(symbol: string, price: number, changePercent: number, marketCap: number): TickerFinancials {
  const quote: Quote = {
    symbol,
    price,
    currency: "USD",
    change: price * (changePercent / 100),
    changePercent,
    marketCap,
    lastUpdated: Date.now(),
  };

  return {
    quote,
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  };
}

function makeProvider(id: AiProvider["id"], name: string = id): AiProvider {
  return {
    id,
    name,
    available: true,
    status: "ready",
    outputModes: ["plain", "structured", "screener"],
  };
}

function installHost(
  output: (options: Parameters<AiRunHost["run"]>[0]) => string | Promise<string>,
): void {
  setAiRunHost({
    async checkStatus() {
      return { available: true, authenticated: true, message: null };
    },
    run(options) {
      return {
        done: Promise.resolve().then(() => output(options)),
        cancel() {},
      };
    },
  });
}

function installSequentialHost(initialOutput: string, rerunOutput: string): void {
  let runCount = 0;
  installHost(() => {
    const output = runCount === 0 ? initialOutput : rerunOutput;
    runCount += 1;
    return output;
  });
}

function ScreenerHarness({
  prompt,
  providerId,
  settings,
  runtime: runtimeOverride,
  onPaneState,
}: {
  prompt: string;
  providerId: string;
  settings?: Record<string, unknown>;
  runtime?: PluginRuntimeAccess;
  onPaneState?: (state: PaneRuntimeState | undefined) => void;
}) {
  const config = createDefaultConfig("/tmp/gloomberb-ai-screener");
  config.layout.instances.push({
    instanceId: PANE_ID,
    paneId: "ai-screener",
    title: "AI Screener",
    params: {
      prompt,
      providerId,
    },
    ...(settings ? { settings } : {}),
  });

  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(config);
    initial.focusedPaneId = PANE_ID;
    initial.tickers = new Map([
      ["AAPL", makeTicker("AAPL", "Apple Inc.")],
      ["MSFT", makeTicker("MSFT", "Microsoft Corp.")],
    ]);
    initial.financials = new Map([
      ["AAPL", makeFinancials("AAPL", 210.12, 1.2, 3_000_000_000_000)],
      ["MSFT", makeFinancials("MSFT", 425.44, 0.8, 3_200_000_000_000)],
    ]);
    return initial;
  });
  const [runtime] = useState(() => runtimeOverride ?? makeRuntime());

  useEffect(() => {
    onPaneState?.(state.paneState[PANE_ID]);
  }, [onPaneState, state.paneState]);

  return (
    <AppContext value={{ state, dispatch }}>
      <TestDialogProvider>
        <PaneInstanceProvider paneId={PANE_ID}>
          <PluginRenderProvider pluginId="ai" runtime={runtime}>
            <PaneFooterProvider>
              {(footer) => (
                <Box flexDirection="column" width={96} height={18}>
                  <AiScreenerPane paneId={PANE_ID} paneType="ai-screener" focused width={96} height={17} />
                  <PaneFooterBar footer={footer} focused width={96} />
                </Box>
              )}
            </PaneFooterProvider>
          </PluginRenderProvider>
        </PaneInstanceProvider>
      </TestDialogProvider>
    </AppContext>
  );
}

async function waitForFrameToContain(text: string, attempts = 30): Promise<string> {
  let lastFrame = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    await act(async () => {
      await Bun.sleep(50);
      await testSetup!.renderOnce();
    });
    const frame = testSetup!.captureCharFrame();
    lastFrame = frame;
    if (frame.includes(text)) return frame;
  }
  throw new Error(`Timed out waiting for "${text}"\n${lastFrame}`);
}

beforeEach(() => {
  setAiRuntimeCatalog({ providers: [], accounts: [], models: [] });
  installHost(() => {
    throw new Error("Test AI host output was not configured.");
  });
});

afterEach(() => {
  setAiRunHost(null);
  setAiRuntimeCatalog({ providers: [], accounts: [], models: [] });
  setDetectedProviders(null);
  setSharedRegistryForTests(undefined);
  setSharedMarketDataForTests(undefined);
  if (testSetup) {
    testSetup.renderer.destroy();
    testSetup = undefined;
  }
});

describe("AiScreenerPane", () => {
  test("migrates legacy global tabs into pane-local state", async () => {
    const runtime = makeRuntime();
    const legacyState = {
      tabs: [createScreenerTab("Find legacy candidates.", "anthropic")],
    };
    runtime.setResumeState("ai", `screener-pane:${PANE_ID}`, legacyState, 1);
    setDetectedProviders([makeProvider("anthropic", "Claude")]);
    let paneState: PaneRuntimeState | undefined;

    testSetup = await testRender(
      <ScreenerHarness
        prompt=""
        providerId="anthropic"
        runtime={runtime}
        onPaneState={(state) => { paneState = state; }}
      />,
      { width: 96, height: 18 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await Bun.sleep(0);
      await testSetup!.renderOnce();
    });
    expect(paneState?.pluginState?.ai?.[AI_SCREENER_PANE_STATE_KEY]).toEqual(legacyState);
    expect(runtime.getResumeState("ai", `screener-pane:${PANE_ID}`, 1)).toEqual(EMPTY_PANE_STATE);
  });

  test("shows the account connection message before trying to run", async () => {
    const provider = makeProvider("anthropic", "Claude");
    setDetectedProviders([provider]);
    setAiRunHost({
      run() {
        throw new Error("provider should not run before it is connected");
      },
      async checkStatus() {
        return {
          available: true,
          authenticated: false,
          message: "Connect Claude in pane settings.",
        };
      },
    });

    testSetup = await testRender(
      <ScreenerHarness prompt="Find candidates." providerId="anthropic" />,
      { width: 96, height: 18 },
    );

    const frame = await waitForFrameToContain("Connect Claude in pane settings.");
    expect(frame).not.toContain("provider should not run");
  });

  test("seeds a screener from pane params and runs it immediately", async () => {
    const provider = makeProvider("anthropic", "Claude");
    installSequentialHost(
      '{"title":"Compounders","summary":"Initial pass","tickers":[{"symbol":"AAPL","exchange":"NASDAQ","reason":"Strong cash flow durability"}]}',
      '{"title":"Compounders","summary":"Second pass","tickers":[{"symbol":"MSFT","exchange":"NASDAQ","reason":"Fresh rerun result"}]}',
    );
    setDetectedProviders([provider]);

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(<ScreenerHarness prompt="Find quality compounders." providerId="anthropic" />, {
      width: 96,
      height: 18,
    });

    await waitForFrameToContain("AAPL");
    const frame = await waitForFrameToContain("Initial pass");
    expect(frame).toContain("Compounders");
    expect(frame).toContain("Initial pass");
    expect(frame).toContain("Strong cash flow durability");
    expect(frame.match(/Strong cash flow durability/g)?.length).toBe(1);
    // `r` refreshes every pane, so it is never advertised per pane.
    expect(frame).not.toContain("[r]efresh");
    expect(frame).not.toContain("[Shift+R]");
    const lines = frame.split("\n");
    const tabLine = lines.findIndex((line) => line.includes("Compounders"));
    const summaryLine = lines.findIndex((line) => line.includes("Initial pass"));
    expect(summaryLine).toBe(tabLine + 1);
  });

  test("uses pane runner overrides without rewriting the seeded tab", async () => {
    setDetectedProviders([
      makeProvider("anthropic", "Claude"),
      makeProvider("openai-codex", "OpenAI"),
    ]);
    installHost(({ providerId, modelId }) => JSON.stringify({
      title: "Override result",
      summary: `${providerId}:${modelId ?? "auto"}`,
      tickers: [{ symbol: "AAPL", exchange: "NASDAQ", reason: "Selected override" }],
    }));

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(
      <ScreenerHarness
        prompt="Find override candidates."
        providerId="anthropic"
        settings={{ providerId: "openai-codex", modelId: "override-model" }}
      />,
      { width: 96, height: 18 },
    );

    const frame = await waitForFrameToContain("openai-codex:override-model");
    expect(frame).toContain("Selected override");
    expect(frame).not.toContain("anthropic:auto");
  });

  test("replaces results on refresh", async () => {
    const provider = makeProvider("anthropic", "Claude");
    installSequentialHost(
      '{"title":"Compounders","summary":"Initial pass","tickers":[{"symbol":"AAPL","exchange":"NASDAQ","reason":"Strong cash flow durability"}]}',
      '{"title":"Compounders","summary":"Second pass","tickers":[{"symbol":"MSFT","exchange":"NASDAQ","reason":"Fresh rerun result"}]}',
    );
    setDetectedProviders([provider]);

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(<ScreenerHarness prompt="Find quality compounders." providerId="anthropic" />, {
      width: 96,
      height: 18,
    });

    await waitForFrameToContain("AAPL");

    await act(async () => {
      testSetup!.mockInput.pressKey("r");
      await testSetup!.renderOnce();
    });

    await waitForFrameToContain("MSFT");
    const frame = await waitForFrameToContain("Second pass");
    expect(frame).not.toContain("AAPL");
    expect(frame).toContain("MSFT");
  });

  test("opens the inline prompt editor without using the dialog flow", async () => {
    const provider = makeProvider("anthropic", "Claude");
    installSequentialHost(
      '{"title":"Compounders","summary":"Initial pass","tickers":[{"symbol":"AAPL","exchange":"NASDAQ","reason":"Strong cash flow durability"}]}',
      '{"title":"Compounders","summary":"Second pass","tickers":[{"symbol":"MSFT","exchange":"NASDAQ","reason":"Fresh rerun result"}]}',
    );
    setDetectedProviders([provider]);

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(<ScreenerHarness prompt="Find quality compounders." providerId="anthropic" />, {
      width: 96,
      height: 18,
    });

    await waitForFrameToContain("AAPL");

    await act(async () => {
      testSetup!.mockInput.pressKey("e");
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("[Ctrl+S]save");
    expect(frame).toContain("[Ctrl+S]save");
    expect(frame).toContain("[Esc]cancel");
    expect(frame).toContain("Find quality compounders.");
  });

  test("does not show a stale prompt-changed status while a refresh is active", async () => {
    const provider = makeProvider("anthropic", "Claude");
    setDetectedProviders([provider]);
    installHost(() => new Promise<string>(() => {}));

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(
      <ScreenerHarness prompt="Find quality compounders." providerId="anthropic" />,
      { width: 96, height: 18 },
    );

    await waitForFrameToContain("Running AI screener...");
    const frame = await waitForFrameToContain("Refreshing");
    expect(frame).not.toContain("Prompt changed");
    expect(frame).not.toContain("Refresh to rerun");
  });

  test("keeps the last good results visible when a rerun returns invalid JSON", async () => {
    const provider = makeProvider("anthropic", "Claude");
    installSequentialHost(
      '{"title":"Compounders","summary":"Initial pass","tickers":[{"symbol":"AAPL","exchange":"NASDAQ","reason":"Strong cash flow durability"}]}',
      "not-json",
    );
    setDetectedProviders([provider]);

    const dataProvider = createTestDataProvider();
    setSharedMarketDataForTests(dataProvider);
    setSharedRegistryForTests({
      dataProvider,
      tickerRepository: {
        loadTicker: async () => null,
        createTicker: async (metadata: TickerRecord["metadata"]) => ({ metadata }),
        saveTicker: async () => {},
      },
      events: { emit() {} },
      pinTicker() {},
    } as any);

    testSetup = await testRender(<ScreenerHarness prompt="Find quality compounders." providerId="anthropic" />, {
      width: 96,
      height: 18,
    });

    await waitForFrameToContain("AAPL");

    await act(async () => {
      testSetup!.mockInput.pressKey("r");
      await testSetup!.renderOnce();
    });

    const frame = await waitForFrameToContain("invalid");
    expect(frame).toContain("AAPL");
  });

});
