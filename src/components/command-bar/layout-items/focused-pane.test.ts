import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID, cloneLayout, createDefaultConfig, type LayoutConfig } from "../../../types/config";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutItemsContext } from "./types";
import { buildFocusedPaneLayoutItems } from "./focused-pane";

function twoPaneState(): AppState {
  const config = createDefaultConfig("/tmp/gloomberb-focused-pane-items-test");
  const layout: LayoutConfig = cloneLayout(config.layout);
  return {
    ...createInitialState({ ...config, layout, layouts: [{ name: "Home", layout: cloneLayout(layout) }] }),
    focusedPaneId: "ticker-detail:main",
  };
}

function itemsFor(state: AppState, calls: string[]) {
  const context: LayoutItemsContext = {
    closeAll: () => {},
    currentLayout: state.config.layout,
    dispatch: () => {},
    duplicatePane: () => {},
    focusedPaneId: state.focusedPaneId,
    getState: () => state,
    openBuiltInWorkflow: () => {},
    openInlineConfirm: () => {},
    persistLayoutChange: () => {},
    pluginRegistry: {
      panes: new Map([[TICKER_RESEARCH_PANE_ID, { id: TICKER_RESEARCH_PANE_ID, name: "Ticker Research", component: () => null }]]),
      movePaneToNewLayout: (paneId: string) => { calls.push(`new:${paneId}`); return true; },
      movePaneBack: (paneId: string) => { calls.push(`back:${paneId}`); return true; },
    } as unknown as PluginRegistry,
    pushRoute: () => {},
    state,
  };
  return buildFocusedPaneLayoutItems(context);
}

describe("focused pane layout items", () => {
  test("offer Move to New Layout beside Fullscreen Pane, and Move Back once the pane has moved", () => {
    const calls: string[] = [];
    let state = twoPaneState();
    let items = itemsFor(state, calls);
    const ids = items.map((item) => item.id);
    expect(ids.indexOf("layout-move-to-new-layout")).toBe(ids.indexOf("layout-fullscreen") + 1);
    expect(items.find((item) => item.id === "layout-move-to-new-layout")?.disabled).toBe(false);
    expect(ids).not.toContain("layout-move-back");
    items.find((item) => item.id === "layout-move-to-new-layout")!.action();
    expect(calls).toEqual(["new:ticker-detail:main"]);

    state = appReducer(state, { type: "MOVE_PANE_TO_NEW_LAYOUT", paneId: "ticker-detail:main", name: "AAPL", sourceLayoutId: "layout:home" });
    items = itemsFor(state, calls);
    expect(items.find((item) => item.id === "layout-move-to-new-layout")).toMatchObject({
      disabled: true,
      detail: "Already the only pane in this layout",
    });
    const back = items.find((item) => item.id === "layout-move-back");
    expect(back?.label).toBe("Move Back to Home");
    back!.action();
    expect(calls).toEqual(["new:ticker-detail:main", "back:ticker-detail:main"]);
  });
});
