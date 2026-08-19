import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { Box } from "../../../ui";
import { testRender } from "../../../renderers/opentui/test-utils";
import {
  AppContext,
  createInitialState,
  PaneInstanceProvider,
} from "../../../state/app/context";
import { cloneLayout, createDefaultConfig, TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../runtime";
import { correlationModule } from ".";

const TEST_PANE_ID = "correlation:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeTicker(symbol: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange: "NASDAQ",
      currency: "USD",
      name: symbol,
      portfolios: [],
      watchlists: [],
      positions: [],
      broker_contracts: [],
      custom: {},
      tags: [],
    },
  };
}

function CorrelationHarness({ runtime }: { runtime: PluginRuntimeAccess }) {
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: "correlation",
      settings: {
        rangePreset: "1Y",
        symbols: ["AAPL", "MSFT"],
        symbolsText: "AAPL, MSFT",
      },
    }],
    floating: [],
    detached: [],
  };
  const config = {
    ...createDefaultConfig("/tmp/gloomberb-correlation-test"),
    layout,
    layouts: [{ name: "Default", layout: cloneLayout(layout) }],
  };
  const state = createInitialState(config);
  state.focusedPaneId = TEST_PANE_ID;
  state.tickers = new Map([
    ["AAPL", makeTicker("AAPL")],
    ["MSFT", makeTicker("MSFT")],
  ]);

  const CorrelationPane = correlationModule.panes?.[0]?.component as (props: {
    paneId: string;
    paneType: string;
    focused: boolean;
    width: number;
    height: number;
  }) => ReactElement;

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PluginRenderProvider pluginId="market-overview" runtime={runtime}>
          <Box width={60} height={8}>
            <CorrelationPane
              paneId={TEST_PANE_ID}
              paneType="correlation"
              focused
              width={60}
              height={8}
            />
          </Box>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
      await Promise.resolve();
    });
  }
  testSetup = undefined;
});

describe("correlationModule", () => {
  test("opens tickers from row and column labels", async () => {
    const opened: Array<{ symbol: string; options: { floating?: boolean; paneType?: string } | undefined }> = [];
    const runtime = createTestPluginRuntime({
      pinTicker: (symbol, options) => opened.push({ symbol, options }),
      navigateTicker: () => {
        throw new Error("known correlation tickers should open directly");
      },
    });

    await act(async () => {
      testSetup = await testRender(<CorrelationHarness runtime={runtime} />, {
        width: 60,
        height: 8,
      });
    });
    await act(async () => {
      await testSetup!.renderOnce();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    const lines = testSetup!.captureCharFrame().split("\n");
    // The first AAPL+MSFT line is the in-pane ticker input, so skip comma-separated rows.
    const headerY = lines.findIndex((line) => line.includes("AAPL") && line.includes("MSFT") && !line.includes(","));
    const headerCol = lines[headerY]?.indexOf("AAPL") ?? -1;
    expect(headerY).toBeGreaterThanOrEqual(0);
    expect(headerCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(headerCol + 1, headerY);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    const rowY = lines.findIndex((line, index) => index > headerY && line.includes("MSFT"));
    const rowCol = lines[rowY]?.indexOf("MSFT") ?? -1;
    expect(rowY).toBeGreaterThanOrEqual(0);
    expect(rowCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(rowCol + 1, rowY);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    expect(opened).toEqual([
      { symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } },
      { symbol: "MSFT", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } },
    ]);
  });
});
