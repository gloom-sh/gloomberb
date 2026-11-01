import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { AppContextStoreValue } from "../../../state/app/context";
import { createPaneInstance, type LayoutConfig } from "../../../types/config";
import type { PinTickerOptions } from "../../../types/plugin";
import { offerTickerListings } from "../../../app/pane-runtime/ticker-open-target";
import { AmbiguousTickerError } from "../../../tickers/search";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();

/** The Options desk's shape: OMON on SPY, OPX following it, and OPX focused. */
const optionsDesk: LayoutConfig = {
  dockRoot: { kind: "split", axis: "horizontal", ratio: 0.5, first: { kind: "pane", instanceId: "omon" }, second: { kind: "pane", instanceId: "opx" } },
  instances: [
    createPaneInstance("options", { instanceId: "omon", title: "OMON SPY", binding: { kind: "fixed", symbol: "SPY" } }),
    createPaneInstance("options-positioning", { instanceId: "opx", binding: { kind: "follow", sourceInstanceId: "omon" } }),
  ],
  floating: [],
  detached: [],
};

/** How the search opens: the backtick, DES typed in the bar, or an open that named several listings. */
type SearchFrom = "backtick" | "des" | "listings";

async function renderTickerSearch(from: SearchFrom = "backtick") {
  const fromDes = from === "des";
  const opened: Array<{ symbol: string; options?: PinTickerOptions }> = [];
  const storeRef: { current: AppContextStoreValue | null } = { current: null };
  await tui.render(<CommandBarHarness
    query={fromDes ? "DES AAPL" : ""}
    live
    storeRef={storeRef}
    configureState={(state) => ({
      ...state,
      config: { ...state.config, layout: optionsDesk },
      focusedPaneId: "opx",
      ...(from === "backtick" ? { commandBarLaunchRequest: { kind: "ticker-search" as const, query: "", sequence: 1 } } : {}),
      ...(from === "listings" ? { commandBarOpen: false } : {}),
    })}
    configurePluginRegistry={(registry) => {
      const panes = registry.panes as Map<string, unknown>;
      panes.set("options", { id: "options", name: "Options Monitor", component: () => null, defaultPosition: "right", tickerFollower: true });
      panes.set("options-positioning", { id: "options-positioning", name: "Options Positioning", component: () => null, defaultPosition: "right", tickerFollower: true });
      registry.pinTicker = (symbol, options) => { opened.push({ symbol, options }); };
      registry.updateLayout = (layout) => storeRef.current!.dispatch({ type: "UPDATE_LAYOUT", layout });
    }}
  />, { width: 110, height: 24 });
  await tui.setup().renderOnce();
  if (fromDes) {
    // Tab takes a typed DES into DES's own ticker search.
    await tui.emitKeypress({ name: "tab" });
    await tui.waitForFrameToContain("Security Description");
  } else if (from === "listings") {
    await act(async () => { offerTickerListings(new AmbiguousTickerError("AAPL", ["AAPL", "AAPL:XMEX"]), "AAPL", storeRef.current!.dispatch); });
    await tui.waitForFrameToContain("Security Description");
  } else {
    await act(async () => { await tui.setup().mockInput.typeText("AAPL"); });
  }
  await tui.waitForFrameToContain("Apple Inc.");
  const layout = () => storeRef.current!.getState().config.layout;
  return { opened, layout, focus: () => storeRef.current!.getState().focusedPaneId };
}

// The rules themselves are in layout/ticker-retarget.test.ts; these hold the wiring from the
// backtick's search, which DES's own search and Shift+Enter must not take.
test("ticker search's Enter changes the focused pane's linked group, not another pane", async () => {
  const { opened, layout, focus } = await renderTickerSearch();
  // The terminal's bar is narrow; the pane's name shows when it fits.
  expect(tui.frame()).toMatch(/Change ticker\s+New pane Shift\+Enter/);
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual([]);
  expect(layout().instances.find((pane) => pane.instanceId === "omon")).toMatchObject({ title: "OMON AAPL", binding: { kind: "fixed", symbol: "AAPL" } });
  expect(layout().instances.find((pane) => pane.instanceId === "opx")?.binding).toEqual({ kind: "follow", sourceInstanceId: "omon" });
  expect(focus()).toBe("opx");
});

test("Shift+Enter in ticker search opens a new pane and leaves the focused one alone", async () => {
  const { opened, layout } = await renderTickerSearch();
  await tui.emitKeypress({ name: "return", sequence: "\r", shift: true });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual([{ symbol: "AAPL", options: expect.objectContaining({ forceNewPane: true }) }]);
  expect(layout()).toEqual(optionsDesk);
});

test("DES's search still opens Ticker Research from a single-ticker pane", async () => {
  const { opened, layout } = await renderTickerSearch("des");
  expect(tui.frame()).not.toContain("Change ticker");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened.map((entry) => entry.symbol)).toEqual(["AAPL"]);
  expect(layout()).toEqual(optionsDesk);
});

test("the listings of an open that named several open the pick, not the focused pane's group", async () => {
  const { opened, layout } = await renderTickerSearch("listings");
  expect(tui.frame()).not.toContain("Change ticker");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened.map((entry) => entry.symbol)).toEqual(["AAPL"]);
  expect(layout()).toEqual(optionsDesk);
});
