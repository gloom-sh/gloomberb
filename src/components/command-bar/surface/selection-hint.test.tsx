import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { AppContextStoreValue } from "../../../state/app/context";
import type { PinTickerOptions } from "../../../types/plugin";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();

/** The default layout's Ticker Research pane, which follows the portfolio list. */
const RESEARCH = "ticker-detail:main";
const HINT = "Enter here · Shift+Enter new pane";

async function renderBar(query: string, focusedPaneId: string | null, waitFor: string) {
  const opened: Array<{ symbol: string; options?: PinTickerOptions }> = [];
  const storeRef: { current: AppContextStoreValue | null } = { current: null };
  await tui.render(<CommandBarHarness
    query={query}
    live
    storeRef={storeRef}
    configureState={(state) => ({ ...state, focusedPaneId })}
    configurePluginRegistry={(registry) => {
      registry.pinTicker = (symbol, options) => { opened.push({ symbol, options }); };
      registry.updateLayout = (layout) => storeRef.current!.dispatch({ type: "UPDATE_LAYOUT", layout });
    }}
  />, { width: 120, height: 24 });
  await tui.setup().renderOnce();
  await tui.waitForFrameToContain(waitFor);
  const prompt = () => tui.frame().split("\n")[0]!;
  const research = () => storeRef.current!.getState().config.layout.instances.find((pane) => pane.instanceId === RESEARCH);
  return { opened, prompt, research };
}

// The hint has to say what the keys do, so each case also runs the key it names.
test("a ticker row names Enter and Shift+Enter when Enter changes the focused research pane", async () => {
  const { opened, prompt, research } = await renderBar("AAPL", RESEARCH, "Apple Inc.");
  // At the end of the prompt, clear of the typed text.
  expect(prompt()).toMatch(/> AAPL {2,}Enter here · Shift\+Enter new pane {2,}/);
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual([]);
  expect(research()?.binding).toMatchObject({ kind: "fixed", symbol: "AAPL" });

  const again = await renderBar("AAPL", RESEARCH, "Apple Inc.");
  await tui.emitKeypress({ name: "return", sequence: "\r", shift: true });
  await tui.waitForFrameToContain("bar:closed");
  expect(again.opened).toEqual([{ symbol: "AAPL", options: expect.objectContaining({ forceNewPane: true }) }]);
  expect(again.research()?.binding).toEqual({ kind: "follow", sourceInstanceId: "portfolio-list:main" });
});

test("a typed DES names the keys too, as it opens like a ticker row", async () => {
  const { prompt } = await renderBar("DES MSFT", RESEARCH, "Microsoft");
  expect(prompt()).toContain(HINT);
});

// Enter opens a research pane from anywhere else, as Shift+Enter does: nothing to tell apart.
test.each([
  ["another pane focused", "portfolio-list:main"],
  ["no pane focused", null],
])("a ticker row names no keys with %s", async (_label, focused) => {
  const { opened, prompt } = await renderBar("AAPL", focused, "Apple Inc.");
  expect(prompt()).not.toContain("new pane");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened.map((entry) => entry.symbol)).toEqual(["AAPL"]);
});

// A function or a command runs the same on Shift+Enter, whatever has the focus.
test.each([
  ["a function", "PF", "PF Portfolio"],
  ["a command", "scan mov", "Scan Movers"],
])("%s names no keys", async (_label, query, row) => {
  const { prompt } = await renderBar(query, RESEARCH, row);
  expect(prompt()).not.toContain("new pane");
});
