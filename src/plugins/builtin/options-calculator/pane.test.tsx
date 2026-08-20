import { afterEach, expect, test } from "bun:test";
import { useReducer } from "react";
import { act } from "react";
import { useShortcut } from "../../../react/input";
import { testRender } from "../../../renderers/opentui/test-utils";
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

function Harness({ params }: { params?: Record<string, string> }) {
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
        <PluginRenderProvider pluginId="ticker-research" runtime={createTestPluginRuntime()}>
          <OptionsCalculatorPane
            paneId={TEST_PANE_ID}
            paneType={OPTIONS_CALCULATOR_PANE_ID}
            focused
            width={90}
            height={18}
          />
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function render(params?: Record<string, string>) {
  await act(async () => {
    testSetup = await testRender(<Harness params={params} />, { width: 90, height: 18 });
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

test("opens on defaults with no seed and leaves implied volatility empty", async () => {
  await render();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("Spot");
  expect(frame).toContain("Market");
  expect(frame).toMatch(/Implied IV\s+—/);
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
