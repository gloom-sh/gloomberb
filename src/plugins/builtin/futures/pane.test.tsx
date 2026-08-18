import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { PinTickerOptions, QuoteBatchResult } from "../../../types/plugin";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { futuresModule } from "./index";

const FuturesPane = futuresModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
const pinned: Array<{ symbol: string; options?: PinTickerOptions }> = [];

afterEach(async () => {
  pinned.length = 0;
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function makeRuntime(): PluginRuntimeAccess {
  const marketData = {
    getQuote: async (symbol: string) => ({
      symbol,
      price: 100,
      change: 1,
      changePercent: 1,
      marketState: "REGULAR" as const,
      lastUpdated: Date.now(),
    }),
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => (
      targets.map((target) => ({
        target: { symbol: target.symbol, exchange: "" },
        quote: {
          symbol: target.symbol,
          price: 100,
          change: 1,
          changePercent: 1,
          marketState: "REGULAR" as const,
          lastUpdated: Date.now(),
        },
      })) as QuoteBatchResult[]
    ),
  };

  return {
    getMarketData: () => marketData as never,
    getCapability: () => null,
    getBrokerAdapter: () => null,
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    pinTicker: (symbol, options) => {
      pinned.push({ symbol, options });
    },
    navigateTicker: () => {},
    selectTicker: () => {},
    switchTab: () => {},
    switchPanel: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    openPaneSettings: () => {},
    openPluginCommandWorkflow: () => {},
    notify: () => {},
    subscribeResumeState: () => () => {},
    getResumeState: () => null,
    setResumeState: () => {},
    deleteResumeState: () => {},
    getConfigState: () => null,
    setConfigState: async () => {},
    setConfigStates: async () => {},
    deleteConfigState: async () => {},
    getConfigStateKeys: () => [],
  } as unknown as PluginRuntimeAccess;
}

function Harness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-futures-pane-test"));
  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PluginRenderProvider runtime={makeRuntime()} pluginId="market-overview">
        <PaneInstanceProvider paneId="futures">
          <FuturesPane paneId="futures" paneType="futures" focused width={80} height={24} />
        </PaneInstanceProvider>
      </PluginRenderProvider>
    </AppContext>
  );
}

async function renderSettled() {
  await act(async () => {
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
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
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    } as never);
    await testSetup!.renderOnce();
  });
}

describe("FuturesPane", () => {
  test("collapses and expands a sector from the keyboard", async () => {
    testSetup = await testRender(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    // Selection starts on the first contract, so step up onto its header.
    expect(testSetup.captureCharFrame()).toContain("E-Mini S&P 500");
    expect(testSetup.captureCharFrame()).toContain("▼ Equity Index");

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    const collapsed = testSetup.captureCharFrame();
    expect(collapsed).toContain("▶ Equity Index");
    expect(collapsed).not.toContain("E-Mini S&P 500");
    // Other sectors keep their contracts.
    expect(collapsed).toContain("WTI Crude Oil");

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("E-Mini S&P 500");
  });

  test("opens the selected contract in ticker research", async () => {
    testSetup = await testRender(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();

    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.symbol).toBe("ES=F");
    expect(pinned[0]!.options).toMatchObject({ floating: true });
  });

  test("search narrows the board to matching contracts", async () => {
    testSetup = await testRender(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "s", sequence: "s" });
    await renderSettled();
    for (const character of "gold") {
      await emitKeypress({ name: character, sequence: character });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await testSetup!.renderOnce();
    });
    await renderSettled();

    const filtered = testSetup.captureCharFrame();
    expect(filtered).toContain("Gold");
    expect(filtered).not.toContain("E-Mini S&P 500");
  });
});
