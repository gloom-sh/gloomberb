import { afterEach, expect, test } from "bun:test";
import { useReducer } from "react";
import { act } from "react";
import { useShortcut } from "../../../react/input";
import { emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { PaneKeyboardScrollController } from "../../../state/pane-scroll-registry";
import {
  AppContext,
  PaneInstanceProvider,
  appReducer,
  createInitialState,
} from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { PluginRenderProvider } from "../../runtime";
import { cloneLayout, createDefaultConfig } from "../../../types/config";
import { OPTIONS_CALCULATOR_PANE_ID } from "./model";
import { OptionsCalculatorPane } from "./pane";

const TEST_PANE_ID = "options-calculator:test";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

function GlobalTabHandler() {
  useShortcut((event) => {
    if (event.name !== "tab") return;
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "before" });
  return null;
}

function Harness({ params, width = 90, height = 18 }: { params?: Record<string, string>; width?: number; height?: number }) {
  const config = createDefaultConfig("/tmp/gloomberb-options-calculator-test");
  config.layout = {
    dockRoot: { kind: "pane", instanceId: TEST_PANE_ID },
    instances: [{
      instanceId: TEST_PANE_ID,
      paneId: OPTIONS_CALCULATOR_PANE_ID,
      binding: { kind: "none" },
      params,
    }],
    floating: [],
    detached: [],
  };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];

  const initialState = createInitialState(config);
  initialState.focusedPaneId = TEST_PANE_ID;
  const [state, dispatch] = useReducer(appReducer, initialState);

  return (
    <AppContext value={{ state, dispatch }}>
      <GlobalTabHandler />
      <PaneInstanceProvider paneId={TEST_PANE_ID}>
        <PaneKeyboardScrollController paneId={TEST_PANE_ID} focused />
        <PluginRenderProvider pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <OptionsCalculatorPane
            paneId={TEST_PANE_ID}
            paneType={OPTIONS_CALCULATOR_PANE_ID}
            focused
            width={width}
            height={height}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function render(params?: Record<string, string>, width = 90, height = 18) {
  await act(async () => {
    testSetup = await testRender(<Harness params={params} width={width} height={height} />, { width, height });
    await Promise.resolve();
    await testSetup.renderOnce();
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
  }
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => { testSetup!.renderer.destroy(); });
    testSetup = undefined;
  }
});

test("narrow results keep assumptions visible while scrolling Greeks and editing fixed inputs", async () => {
  await render({
    symbol: "COST:XNAS", side: "call", spot: "902.63", strike: "905", days: "14.1784",
    volatility: "0.269", rate: "0.04", marketPrice: "18.075", marketPriceSource: "mid",
    marketReference: JSON.stringify({ contractSymbol: "COST260925C00905000", expiration: 1790294400,
      currency: "USD", bid: 17.2, ask: 18.95, lastPrice: 18.67, lastTradeDate: 1789139450 }),
  }, 48, 16);
  expect(testSetup!.captureCharFrame()).toContain("COST260925C00905000");
  expect(testSetup!.captureCharFrame()).toContain("discrete dividends.");
  await emitKeypress(testSetup!, { name: "end", sequence: "\u001B[F" });
  const bottom = testSetup!.captureCharFrame();
  expect(bottom).toMatch(/Theta\s+-[\d.]+\s+per day/);
  expect(bottom).toMatch(/Vega\s+[\d.]+\s+per vol pt/);
  expect(bottom).toMatch(/Rho\s+[+\d.]+\s+per rate pt/);
  expect(bottom).toContain("discrete dividends.");

  // Inputs stay reachable while the researcher reads the bottom of the results.
  await emitKeypress(testSetup!, { name: "tab", sequence: "\t" });
  await act(async () => { await testSetup!.mockInput.typeText("910"); testSetup!.mockInput.pressEnter(); });
  await act(async () => { await testSetup!.renderOnce(); });
  expect(testSetup!.captureCharFrame()).toMatch(/Spot\s+910/);
  await emitKeypress(testSetup!, { name: "escape", sequence: "\u001B" });
  await emitKeypress(testSetup!, { name: "home", sequence: "\u001B[H" });
  expect(testSetup!.captureCharFrame()).toContain("COST260925C00905000");
});

test("prices the seeded contract and solves its implied volatility", async () => {
  await render({
    symbol: "AAPL",
    side: "put",
    spot: "100",
    strike: "100",
    days: "365",
    rate: "0.05",
    volatility: "0.2",
    marketPrice: "5.5735",
  });

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("AAPL");
  expect(frame).toContain("5.5735");
  // The seeded market price is exactly the model put value, so IV solves back to 20%.
  expect(frame).toMatch(/Implied IV\s+20\.00%/);
  expect(frame).toContain("European exercise");
});

test("shows the remaining fraction of a day for a live near-expiry contract", async () => {
  await render({ days: "0.25" });
  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Days\s+0\.25\s*d/);
  expect(frame).toMatch(/Implied IV\s+—/);
});

test("displays fractional strikes and spot prices without rounding them to whole dollars", async () => {
  await render({ spot: "217.987", strike: "217.5", marketPrice: "100.125", marketPriceSource: "mid" });
  const frame = testSetup!.captureCharFrame();
  expect(frame).toMatch(/Spot\s+217\.987/);
  expect(frame).toMatch(/Strike\s+217\.5/);
  expect(frame).toMatch(/Mid\s+100\.125/);
  expect(frame).toContain("per unit");
});

test("tabs into fields and edits them from the keyboard", async () => {
  await render();

  await act(async () => {
    testSetup!.mockInput.pressTab();
    await testSetup!.renderOnce();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
  await act(async () => {
    await testSetup!.mockInput.typeText("120");
    testSetup!.mockInput.pressEnter();
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });

  expect(testSetup!.captureCharFrame()).toMatch(/Spot\s+120/);
});
