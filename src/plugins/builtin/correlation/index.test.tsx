import { describe, expect, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { Box } from "../../../ui";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PluginRuntimeAccess } from "../../runtime";
import { correlationModule } from ".";
import { TestPaneProvider, createTestTicker, createTestPaneConfig } from "../../../test-support/pane";

const TEST_PANE_ID = "correlation:test";

const tui = createOpenTuiTestHarness();

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
      ["AAPL", createTestTicker("AAPL", "AAPL", { broker_contracts: [] })],
      ["MSFT", createTestTicker("MSFT", "MSFT", { broker_contracts: [] })],
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

describe("correlationModule", () => {
  test("keys and cell clicks open the selected pair while diagonal and hovered symbols retain ticker navigation", async () => {
    const opened: unknown[] = [];
    const runtime = createTestPluginRuntime({
      createPaneFromTemplate: (id, options) => {
        // The app's ticker-list template workflow resolves arg before symbols;
        // symbols alone opens its wizard instead of the pair view.
        expect(options?.arg).toBe(options?.symbols?.join(", "));
        opened.push([id, options?.symbols]);
      },
      pinTicker: (symbol) => opened.push(symbol),
    });
    await tui.render(<CorrelationHarness runtime={runtime} />, { width: 60, height: 8 });
    await tui.waitForFrameToContain("MSFT");
    const key = (name: string) => tui.emitKeypress({ name }, { trackPropagation: true, afterCommit: true });
    await key("return"); // Default off-diagonal pair.
    await key("left");
    await key("return"); // AAPL diagonal.
    await key("j");
    await key("return"); // MSFT/AAPL.
    await key("l");
    await key("return"); // MSFT diagonal.
    await key("up");
    await key("h");
    await key("h"); // Symbol column.
    await key("down");
    await key("return"); // MSFT row symbol.
    await key("k");
    await key("right");
    await key("return"); // AAPL diagonal again.

    const lines = tui.frame().split("\n");
    const header = lines.findIndex((line) => line.includes("AAPL") && line.includes("MSFT") && !line.includes(","));
    const msftColumn = lines[header]!.indexOf("MSFT");
    await act(async () => {
      await tui.setup().mockMouse.click(msftColumn, header + 1);
      await tui.setup().renderOnce();
    });
    await key("return"); // Click selected AAPL/MSFT, without opening it on the click.
    await act(async () => {
      await tui.setup().mockMouse.moveTo(2, header + 2);
      await tui.setup().renderOnce();
    });
    await key("return"); // Hovered MSFT header overrides the pair for Enter.
    await key("k");
    await key("return"); // Row keys continue from that hovered symbol.
    expect(opened).toEqual([
      ["relationship-graph-pane", ["AAPL", "MSFT"]], "AAPL",
      ["relationship-graph-pane", ["MSFT", "AAPL"]], "MSFT", "MSFT", "AAPL",
      ["relationship-graph-pane", ["AAPL", "MSFT"]], "MSFT", "AAPL",
    ]);
  });

  test("a batch of cursor keys accumulates every move before React commits", async () => {
    const pairs: unknown[] = [];
    await tui.render(<CorrelationHarness runtime={createTestPluginRuntime({
      createPaneFromTemplate: (_id, options) => pairs.push(options?.symbols),
    })} />, { width: 60, height: 8 });
    await tui.waitForFrameToContain("MSFT");
    await tui.emitKeypress([{ name: "left" }, { name: "down" }], { trackPropagation: true, afterCommit: true });
    await tui.emitKeypress({ name: "return" }, { trackPropagation: true, afterCommit: true });
    expect(pairs).toEqual([["MSFT", "AAPL"]]);
  });

  test("opens tickers from row and column labels", async () => {
    const opened: Array<{ symbol: string; options: { floating?: boolean; paneType?: string } | undefined }> = [];
    const runtime = createTestPluginRuntime({
      pinTicker: (symbol, options) => opened.push({ symbol, options }),
      navigateTicker: () => {
        throw new Error("known correlation tickers should open directly");
      },
    });

    await act(async () => {
      await tui.render(<CorrelationHarness runtime={runtime} />, {
        width: 60,
        height: 8,
      });
    });
    await act(async () => {
      await tui.setup().renderOnce();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    const lines = tui.frame().split("\n");
    // The first AAPL+MSFT line is the in-pane ticker input, so skip comma-separated rows.
    const headerY = lines.findIndex((line) => line.includes("AAPL") && line.includes("MSFT") && !line.includes(","));
    const headerCol = lines[headerY]?.indexOf("AAPL") ?? -1;
    expect(headerY).toBeGreaterThanOrEqual(0);
    expect(headerCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(headerCol + 1, headerY);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    const rowY = lines.findIndex((line, index) => index > headerY && line.includes("MSFT"));
    const rowCol = lines[rowY]?.indexOf("MSFT") ?? -1;
    expect(rowY).toBeGreaterThanOrEqual(0);
    expect(rowCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.click(rowCol + 1, rowY);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    expect(opened).toEqual([
      { symbol: "AAPL", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } },
      { symbol: "MSFT", options: { floating: true, paneType: TICKER_RESEARCH_PANE_ID } },
    ]);
  });

  test("Esc puts the ticker list back after an edit instead of emptying it to the defaults", async () => {
    const wait = (ms: number) => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.render(<CorrelationHarness runtime={createTestPluginRuntime()} />, { width: 60, height: 8 });
    });
    await wait(0);

    await tui.emitKeypress({ name: "/", sequence: "/" }, { trackPropagation: true, afterCommit: true });
    await wait(20);
    await act(async () => {
      await tui.setup().mockInput.typeText("X");
      await tui.setup().renderOnce();
    });
    // The field shows the draft, applied once typing pauses.
    await wait(600);
    expect(tui.frame()).toMatch(/XAAPL|MSFTX/);

    await tui.emitKeypress({ name: "escape", sequence: "\u001B" }, { trackPropagation: true, afterCommit: true });
    await wait(600);
    const frame = tui.frame();
    expect(frame).toContain("AAPL, MSFT");
    expect(frame).not.toMatch(/XAAPL|MSFTX/);
    expect(frame).not.toContain("NVDA");
  });
});
