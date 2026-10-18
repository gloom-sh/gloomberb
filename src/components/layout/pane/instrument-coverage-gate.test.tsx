import { act } from "react";
import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneDef } from "../../../types/plugin";
import { Text } from "../../../ui";
import { InstrumentCoverageGate } from "./instrument-coverage-gate";

const tui = createOpenTuiTestHarness();

const HIRING: PaneDef = { id: "jobs", name: "Hiring", component: () => null, defaultPosition: "right", instruments: ["equity"] };

/** The frame of a Hiring pane bound to `symbol`, saved with `assetCategory` (none when omitted). */
async function gateFrame(symbol: string, assetCategory?: string): Promise<string> {
  const id = "jobs:test";
  const state = createInitialState(createTestPaneConfig("/tmp/instrument-coverage-gate-test", {
    paneId: "jobs", instanceId: id, binding: { kind: "fixed", symbol },
  }));
  state.tickers.set(symbol, createTestTicker(symbol, symbol, assetCategory ? { assetCategory } : {}));
  await act(async () => {
    await tui.render(
      <TestPaneProvider state={state} paneId={id} pluginId="jobs" runtime={createTestPluginRuntime()}>
        <InstrumentCoverageGate pane={HIRING}><Text>hiring body</Text></InstrumentCoverageGate>
      </TestPaneProvider>,
      { width: 90, height: 8 },
    );
  });
  await tui.renderFrames(2);
  return tui.frame();
}

test("a company pane bound to an ETF says what it is and offers its research instead of the pane", async () => {
  const frame = await gateFrame("VOO", "ETF");
  expect(frame).toContain("Hiring covers companies only, and VOO is an ETF.");
  expect(frame).toContain("Open VOO");
  expect(frame).not.toContain("hiring body");
});

// A saved stock and a symbol nothing names (no saved type, no quote yet) are
// not refused on a guess: the pane renders and its source answers.
test("a ticker whose type is a stock or unknown renders the pane", async () => {
  expect(await gateFrame("AAPL", "STK")).toContain("hiring body");
  const unknown = await gateFrame("ZZZQ");
  expect(unknown).toContain("hiring body");
  expect(unknown).not.toContain("covers companies only");
});
