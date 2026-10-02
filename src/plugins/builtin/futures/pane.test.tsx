import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import type { QuoteBatchResult } from "../../../types/data-provider";
import type { PinTickerOptions } from "../../../types/plugin";
import type { PluginRuntimeAccess } from "../../runtime";
import { futuresModule } from "./index";
import { TestPaneProvider } from "../../../test-support/pane";

const FuturesPane = futuresModule.panes![0]!.component as (props: {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
}) => React.ReactNode;

const tui = createOpenTuiTestHarness();
const pinned: Array<{ symbol: string; options?: PinTickerOptions }> = [];

afterEach(() => {
  pinned.length = 0;
});

function makeRuntime(quoteError?: string): PluginRuntimeAccess {
  const marketData = quoteError ? {
    getQuote: async () => { throw new Error(quoteError); },
    getQuotesBatch: async (targets: Array<{ symbol: string }>): Promise<QuoteBatchResult[]> => (
      targets.map((target) => ({ target: { symbol: target.symbol, exchange: "" }, quote: null, error: new Error(quoteError) })) as QuoteBatchResult[]
    ),
  } : {
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
    pinTicker: (symbol: string, options?: PinTickerOptions) => {
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

function Harness({ quoteError }: { quoteError?: string }) {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-futures-pane-test"));
  return (
    <TestPaneProvider state={state} paneId="futures" runtime={makeRuntime(quoteError)} pluginId="market-overview">
      <FuturesPane paneId="futures" paneType="futures" focused width={80} height={24} />
    </TestPaneProvider>
  );
}

const renderSettled = () => tui.renderFrames(2);

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event);

describe("FuturesPane", () => {
  test("collapses and expands a sector from the keyboard", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    // Selection starts on the first contract, so step up onto its header.
    expect(tui.frame()).toContain("E-Mini S&P 500");
    expect(tui.frame()).toContain("▾ Equity Index");

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    const collapsed = tui.frame();
    expect(collapsed).toContain("▸ Equity Index");
    expect(collapsed).not.toContain("E-Mini S&P 500");
    // Other sectors keep their contracts.
    expect(collapsed).toContain("WTI Crude Oil");

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(tui.frame()).toContain("E-Mini S&P 500");
  });

  test("clicking a sector header collapses it, and clicking again expands it", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    const headerRow = () => tui.frame()
      .split("\n")
      .findIndex((line) => line.includes("Equity Index"));
    const row = headerRow();
    expect(row).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(4, row);
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const collapsed = tui.frame();
    expect(collapsed).toContain("▸ Equity Index");
    expect(collapsed).not.toContain("E-Mini S&P 500");
    // A header click must not also open the pinned-ticker pane.
    expect(pinned).toEqual([]);

    await act(async () => {
      await tui.setup().mockMouse.click(4, headerRow());
      await tui.setup().renderOnce();
    });
    await renderSettled();

    expect(tui.frame()).toContain("E-Mini S&P 500");
    expect(pinned).toEqual([]);
  });

  test("a search shows matches inside a collapsed sector", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    // Collapse Equity Index from its header, then search for one of its rows.
    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(tui.frame()).not.toContain("E-Mini Dow");

    await emitKeypress({ name: "/", sequence: "/" });
    for (const character of "dow") {
      await emitKeypress({ name: character, sequence: character });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const searching = tui.frame();
    expect(searching).toContain("E-Mini Dow");
    expect(searching).toContain("▾ Equity Index");
  });

  test("opens the selected contract in ticker research", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();

    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.symbol).toBe("ES=F");
    expect(pinned[0]!.options).toMatchObject({ floating: true });
  });

  test("a board where no quote arrived says so instead of drawing dashes", async () => {
    await tui.render(<Harness quoteError="Quotes are offline" />, { width: 80, height: 24 });
    await renderSettled();
    await renderSettled();

    const frame = tui.frame();
    expect(frame).toContain("Futures quotes unavailable.");
    expect(frame).toContain("Quotes are offline");
    expect(frame).toContain("Retry");
    expect(frame).not.toContain("E-Mini S&P 500");
  });

  test("search narrows the board to matching contracts", async () => {
    await tui.render(<Harness />, { width: 80, height: 24 });
    await renderSettled();

    await emitKeypress({ name: "/", sequence: "/" });
    await renderSettled();
    for (const character of "gold") {
      await emitKeypress({ name: character, sequence: character });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await tui.setup().renderOnce();
    });
    await renderSettled();

    const filtered = tui.frame();
    expect(filtered).toContain("Gold");
    expect(filtered).not.toContain("E-Mini S&P 500");
  });
});
