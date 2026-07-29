import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../../state/app/context";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createDefaultConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { PluginRenderProvider } from "../../runtime";
import { setSharedMarketDataForTests, setSharedRegistryForTests } from "../../registry";
import {
  AskAiResearchTab as AskAiTab,
  __resetAskAiHistoryForTests,
  __setAskAiHistoryForTests,
} from "./ask-ai-detail-tab";
import { setDetectedProviders, type AiProvider } from "./providers";
import { setAiRunHost, setAiRuntimeCatalog, type AiRunHost } from "./runner";
import type { TickerRecord } from "../../../types/ticker";

const PANE_ID = "ticker-detail:main";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeTicker(symbol: string, name = symbol): TickerRecord {
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

function createAskAiHarness(
  width = 60,
  height = 12,
  onCapture: (capturing: boolean) => void = () => {},
) {
  const config = createDefaultConfig("/tmp/gloomberb-ai");
  config.layout.instances = config.layout.instances.map((instance) => (
    instance.instanceId === PANE_ID
      ? { ...instance, binding: { kind: "fixed" as const, symbol: "AAPL" } }
      : instance
  ));

  const state = createInitialState(config);
  state.focusedPaneId = PANE_ID;
  state.tickers = new Map([["AAPL", makeTicker("AAPL", "Apple Inc.")]]);
  state.financials = new Map([["AAPL", {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    quote: {
      symbol: "AAPL",
      price: 210,
      currency: "USD",
      change: 6.3,
      changePercent: 3,
      lastUpdated: Date.now(),
    },
  }]]);

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={PANE_ID}>
        <PluginRenderProvider pluginId="ai" runtime={createStatefulTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <Box flexDirection="column" width={width} height={height}>
                <AskAiTab width={width} height={Math.max(1, height - 1)} focused onCapture={onCapture} />
                <PaneFooterBar footer={footer} focused width={width} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function flushFrame() {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
}

function setProviders(providers: AiProvider[]) {
  setDetectedProviders(providers);
}

function readyProvider(id: AiProvider["id"] = "anthropic"): AiProvider {
  return {
    id,
    name: id === "anthropic" ? "Claude" : id,
    available: true,
    status: "ready",
    outputModes: ["plain", "structured", "screener"],
  };
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy();
    });
    testSetup = undefined;
  }
  setDetectedProviders(null);
  __resetAskAiHistoryForTests();
  setAiRunHost(null);
  setAiRuntimeCatalog({ providers: [], accounts: [], models: [] });
  setSharedRegistryForTests(undefined);
  setSharedMarketDataForTests(undefined);
});

describe("AskAiTab", () => {
  test("points to shared pane settings when no AI provider is ready", async () => {
    setProviders([]);

    await act(async () => {
      testSetup = await testRender(
        createAskAiHarness(60, 12),
        { width: 60, height: 12 },
      );
    });

    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("No AI providers are ready.");
    expect(frame).toContain("Open any AI pane's settings");
  });

  test("focuses the input when the prompt row is clicked", async () => {
    setProviders([
      readyProvider(),
    ]);

    await act(async () => {
      testSetup = await testRender(createAskAiHarness(60, 12), {
        width: 60,
        height: 12,
      });
    });

    await flushFrame();

    const frameBeforeClick = testSetup!.captureCharFrame().split("\n");
    const inputRow = frameBeforeClick.findIndex((line) => line.includes("Ask a question..."));
    const inputCol = frameBeforeClick[inputRow]?.indexOf("Ask a question...") ?? -1;

    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(inputCol).toBeGreaterThanOrEqual(0);

    let focusedByClick = false;
    for (const row of [inputRow, inputRow + 1]) {
      for (const col of [inputCol + 1, inputCol + 2]) {
        await act(async () => {
          await testSetup!.mockMouse.click(col, row);
          await testSetup!.renderOnce();
          await testSetup!.renderOnce();
        });
        if (testSetup!.captureCharFrame().includes("Ask a question...")) {
          focusedByClick = true;
          break;
        }
      }
      if (focusedByClick) break;
    }

    expect(focusedByClick).toBe(true);

    await act(async () => {
      await testSetup!.mockInput.typeText("DCF");
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frameAfterType = testSetup!.captureCharFrame();
    expect(frameAfterType).toContain("> DCF");
  });

  test("passes completed history to Pi as structured messages", async () => {
    setProviders([readyProvider()]);
    __setAskAiHistoryForTests("AAPL", [
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "Margins improved.", loading: false },
    ]);
    let request: Parameters<AiRunHost["run"]>[0] | null = null;
    setAiRunHost({
      run(options) {
        request = options;
        return {
          done: Promise.resolve("Growth remains healthy."),
          cancel() {},
        };
      },
    });

    await act(async () => {
      testSetup = await testRender(createAskAiHarness(60, 12), {
        width: 60,
        height: 12,
      });
    });
    await flushFrame();

    const lines = testSetup!.captureCharFrame().split("\n");
    const inputRow = lines.findIndex((line) => line.includes("Ask a question..."));
    const inputCol = lines[inputRow]?.indexOf("Ask a question...") ?? -1;
    await act(async () => {
      await testSetup!.mockMouse.click(inputCol + 1, inputRow);
      await testSetup!.mockInput.typeText("What next?");
      testSetup!.mockInput.pressEnter();
      await Promise.resolve();
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const capturedRequest = request as Parameters<AiRunHost["run"]>[0] | null;
    if (!capturedRequest) throw new Error("Expected a captured AI request");
    expect(capturedRequest.providerId).toBe("anthropic");
    expect(capturedRequest.messages).toEqual([
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "Margins improved." },
    ]);
    expect(capturedRequest.prompt).toContain("User question: What next?");
    expect(capturedRequest.prompt).not.toContain("Margins improved.");
  });

  test("renders assistant ticker badges and opens a floating Ticker Research pane on click", async () => {
    setProviders([
      readyProvider(),
    ]);

    const opened: string[] = [];
    setSharedRegistryForTests({
      pinTicker(symbol: string) {
        opened.push(symbol);
      },
    } as any);

    __setAskAiHistoryForTests("AAPL", [
      { role: "assistant", content: "Watch $AAPL here.", loading: false },
    ]);

    await act(async () => {
      testSetup = await testRender(createAskAiHarness(60, 12), {
        width: 60,
        height: 12,
      });
    });

    await flushFrame();

    const lines = testSetup!.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("AAPL +3%"));
    const col = lines[row]?.indexOf("AAPL +3%") ?? -1;

    expect(row).toBeGreaterThanOrEqual(0);
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(col + 1, row);
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(opened).toEqual(["AAPL"]);
  });

  test("migrates legacy provider history without leaking messages across tickers", async () => {
    setProviders([
      readyProvider(),
    ]);

    const runtime = createStatefulTestPluginRuntime();
    runtime.setResumeState("ai", "conversation:claude:AAPL", {
      updatedAt: Date.now(),
      messages: [
        { role: "user", content: "AAPL question" },
        { role: "assistant", content: "AAPL answer", loading: false },
      ],
    }, 1);
    runtime.setResumeState("ai", "conversation:claude:MSFT", {
      updatedAt: Date.now(),
      messages: [
        { role: "user", content: "MSFT question" },
        { role: "assistant", content: "MSFT answer", loading: false },
      ],
    }, 1);

    let selectSymbol: ((symbol: string) => void) | null = null;

    const config = createDefaultConfig("/tmp/gloomberb-ai-navigation");
    const initialState = createInitialState(config);
    initialState.focusedPaneId = PANE_ID;
    initialState.paneState["portfolio-list:main"] = {
      ...initialState.paneState["portfolio-list:main"],
      cursorSymbol: "AAPL",
    };
    initialState.tickers = new Map([
      ["AAPL", makeTicker("AAPL", "Apple Inc.")],
      ["MSFT", makeTicker("MSFT", "Microsoft Corporation")],
    ]);

    function NavigableAskAiHarness() {
      const [state, dispatch] = useReducer(appReducer, initialState);
      selectSymbol = (symbol) => {
        dispatch({
          type: "UPDATE_PANE_STATE",
          paneId: "portfolio-list:main",
          patch: { cursorSymbol: symbol },
        });
      };

      return (
        <AppContext value={{ state, dispatch }}>
          <PaneInstanceProvider paneId={PANE_ID}>
            <PluginRenderProvider pluginId="ai" runtime={runtime}>
              <PaneFooterProvider>
                {(footer) => (
                  <Box flexDirection="column" width={60} height={12}>
                    <AskAiTab width={60} height={11} focused onCapture={() => {}} />
                    <PaneFooterBar footer={footer} focused width={60} />
                  </Box>
                )}
              </PaneFooterProvider>
            </PluginRenderProvider>
          </PaneInstanceProvider>
        </AppContext>
      );
    }

    await act(async () => {
      testSetup = await testRender(<NavigableAskAiHarness />, {
        width: 60,
        height: 12,
      });
    });
    await flushFrame();

    expect(testSetup!.captureCharFrame()).toContain("AAPL answer");

    await act(() => {
      selectSymbol?.("MSFT");
    });
    await flushFrame();

    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("MSFT answer");
    expect(frame).not.toContain("AAPL answer");
    expect((runtime.getResumeState("ai", "conversation:anthropic:MSFT") as any)?.messages).toEqual([
      { role: "user", content: "MSFT question" },
      { role: "assistant", content: "MSFT answer", loading: false },
    ]);
  });
});
