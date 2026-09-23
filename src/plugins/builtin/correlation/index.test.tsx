import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { Box } from "../../../ui";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { TickerRecord } from "../../../types/ticker";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PluginRuntimeAccess } from "../../runtime";
import { correlationModule } from ".";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "correlation:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function makeTicker(symbol: string): TickerRecord {
  return createTestTicker(symbol, symbol, {
    broker_contracts: []
  });
}

function CorrelationHarness({ runtime }: { runtime: PluginRuntimeAccess }) {
  const config = createTestPaneConfig("/tmp/gloomberb-correlation-test", {
    instanceId: TEST_PANE_ID,
    paneId: "correlation",
    settings: {
      rangePreset: "1Y",
      symbols: ["AAPL", "MSFT"],
      symbolsText: "AAPL, MSFT",
    },
  });
  const [state, dispatch] = useReducer(appReducer, undefined, () => {
    const initial = createInitialState(config);
    initial.focusedPaneId = TEST_PANE_ID;
    initial.tickers = new Map([
      ["AAPL", makeTicker("AAPL")],
      ["MSFT", makeTicker("MSFT")],
    ]);
    return initial;
  });

  const CorrelationPane = correlationModule.panes?.[0]?.component as (props: {
    paneId: string;
    paneType: string;
    focused: boolean;
    width: number;
    height: number;
  }) => ReactElement;

  return (
    <TestPaneProvider state={state} dispatch={dispatch} paneId={TEST_PANE_ID} pluginId="market-overview" runtime={runtime}>
      <Box width={60} height={8}>
        <CorrelationPane
          paneId={TEST_PANE_ID}
          paneType="correlation"
          focused
          width={60}
          height={8}
        />
      </Box>
    </TestPaneProvider>
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

  test("Esc puts the ticker list back after an edit instead of emptying it to the defaults", async () => {
    const wait = (ms: number) => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await testSetup!.renderOnce();
    });
    await act(async () => {
      testSetup = await testRender(<CorrelationHarness runtime={createTestPluginRuntime()} />, { width: 60, height: 8 });
    });
    await wait(0);

    await emitKeypress(testSetup!, { name: "/", sequence: "/" }, { trackPropagation: true, afterCommit: true });
    await wait(20);
    await act(async () => {
      await testSetup!.mockInput.typeText("X");
      await testSetup!.renderOnce();
    });
    // The field shows the draft, applied once typing pauses.
    await wait(600);
    expect(testSetup!.captureCharFrame()).toMatch(/XAAPL|MSFTX/);

    await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" }, { trackPropagation: true, afterCommit: true });
    await wait(600);
    const frame = testSetup!.captureCharFrame();
    expect(frame).toContain("AAPL, MSFT");
    expect(frame).not.toMatch(/XAAPL|MSFTX/);
    expect(frame).not.toContain("NVDA");
  });
});
