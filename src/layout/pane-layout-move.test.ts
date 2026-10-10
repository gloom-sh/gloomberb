import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState, type AppState } from "../core/state/app/state";
import { sanitizeLayout } from "../data/config/layout";
import {
  cloneLayout,
  createDefaultConfig,
  createPaneInstance,
  findPaneInstance,
  type DockLayoutNode,
  type LayoutConfig,
  type SavedLayout,
} from "../types/config";
import { paneMoveBackTarget } from "./pane-layout-move";

const LIST = "portfolio-list:main";
const RESEARCH = "ticker-detail:main";
const CHART = "price-chart:nvda";

const DOCK_ROOT: DockLayoutNode = {
  kind: "split",
  axis: "horizontal",
  ratio: 0.3,
  first: { kind: "pane", instanceId: LIST },
  second: {
    kind: "split",
    axis: "vertical",
    ratio: 0.6,
    first: { kind: "pane", instanceId: RESEARCH },
    second: { kind: "pane", instanceId: CHART },
  },
};

/** A list, a research pane following it and a pinned chart, docked side by side. */
function threePaneLayout(): LayoutConfig {
  const config = createDefaultConfig("/tmp/gloomberb-pane-layout-move-test");
  const list = config.layout.instances.find((instance) => instance.instanceId === LIST)!;
  const research = config.layout.instances.find((instance) => instance.instanceId === RESEARCH)!;
  return {
    dockRoot: structuredClone(DOCK_ROOT),
    instances: [
      { ...list },
      { ...research, binding: { kind: "follow", sourceInstanceId: LIST } },
      createPaneInstance("price-chart", {
        instanceId: CHART,
        binding: { kind: "fixed", symbol: "NVDA" },
        settings: { range: "1Y" },
        locked: true,
      }),
    ],
    floating: [],
    detached: [],
  };
}

function stateWith(layouts: Array<{ name: string; layout: LayoutConfig }>, activeLayoutIndex = 0): AppState {
  const config = createDefaultConfig("/tmp/gloomberb-pane-layout-move-test");
  const state = createInitialState({
    ...config,
    layout: cloneLayout(layouts[activeLayoutIndex]!.layout),
    layouts: layouts.map((entry): SavedLayout => ({ name: entry.name, layout: cloneLayout(entry.layout) })),
    activeLayoutIndex,
  });
  return { ...state, paneState: { ...state.paneState, [LIST]: { ...state.paneState[LIST], cursorSymbol: "AAPL" } } };
}

function moveToNewLayout(state: AppState, paneId: string, name = "Chart: NVDA"): AppState {
  return appReducer(state, { type: "MOVE_PANE_TO_NEW_LAYOUT", paneId, name, sourceLayoutId: `layout:${name}` });
}

describe("Move to New Layout", () => {
  test("gives a docked pane a layout of its own and closes the gap it leaves", () => {
    let state = stateWith([{ name: "Home", layout: threePaneLayout() }]);
    const chartState = { activeTabId: "chart", pluginState: { chart: { scrollTop: 14 } } };
    state = { ...state, paneState: { ...state.paneState, [CHART]: chartState }, focusedPaneId: CHART };

    const next = moveToNewLayout(state, CHART);

    expect(next.config.layouts.map((entry) => entry.name)).toEqual(["Home", "Chart: NVDA"]);
    expect(next.config.activeLayoutIndex).toBe(1);
    expect(next.focusedPaneId).toBe(CHART);
    // Alone and docked, so it fills the window with nothing floating around it.
    expect(next.config.layout.dockRoot).toEqual({ kind: "pane", instanceId: CHART });
    expect(next.config.layout.floating).toEqual([]);
    const moved = findPaneInstance(next.config.layout, CHART)!;
    expect(moved).toMatchObject({ binding: { kind: "fixed", symbol: "NVDA" }, settings: { range: "1Y" }, locked: true });
    // Moved, not recreated: the same state object, mirrored into the new saved layout.
    expect(next.paneState[CHART]).toBe(chartState);
    expect(next.config.layouts[1]!.paneState?.[CHART]).toEqual(chartState);

    const home = next.config.layouts[0]!;
    expect(home.id).toBe("layout:Chart: NVDA");
    expect(home.layout.dockRoot).toEqual({
      kind: "split",
      axis: "horizontal",
      ratio: 0.3,
      first: { kind: "pane", instanceId: LIST },
      second: { kind: "pane", instanceId: RESEARCH },
    });
    expect(home.layout.instances.map((instance) => instance.instanceId)).toEqual([LIST, RESEARCH]);
    expect(home.paneState?.[CHART]).toBeUndefined();

    // Saved and loaded again, the pane still knows where it came from.
    const reloaded = sanitizeLayout(JSON.parse(JSON.stringify(next.config.layouts[1]!.layout)), cloneLayout(home.layout));
    expect(findPaneInstance(reloaded, CHART)?.movedFrom).toEqual(moved.movedFrom);
  });

  test("Move Back returns a pane to its place and share of the split, linked again, and drops the emptied layout", () => {
    const original = threePaneLayout();
    let state = stateWith([{ name: "Home", layout: original }]);
    const researchState = { activeTabId: "financials" };
    state = { ...state, paneState: { ...state.paneState, [RESEARCH]: researchState } };

    state = moveToNewLayout(state, RESEARCH, "AAPL");
    // Alone it has nothing to follow, so it keeps the ticker it showed.
    expect(findPaneInstance(state.config.layout, RESEARCH)?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
    expect(paneMoveBackTarget(state.config, RESEARCH)).toEqual({ index: 0, name: "Home", original: true });

    const back = appReducer(state, { type: "MOVE_PANE_BACK", paneId: RESEARCH });

    expect(back.config.layouts.map((entry) => entry.name)).toEqual(["Home"]);
    expect(back.config.activeLayoutIndex).toBe(0);
    expect(back.focusedPaneId).toBe(RESEARCH);
    expect(back.config.layout.dockRoot).toEqual(DOCK_ROOT);
    const returned = findPaneInstance(back.config.layout, RESEARCH)!;
    expect(returned.binding).toEqual({ kind: "follow", sourceInstanceId: LIST });
    expect(returned.movedFrom).toBeUndefined();
    expect(back.paneState[RESEARCH]).toBe(researchState);
  });

  test("relinks the panes that followed a moved list once the list is back", () => {
    let state = stateWith([{ name: "Home", layout: threePaneLayout() }]);

    state = moveToNewLayout(state, LIST, "Main Portfolio");
    expect(findPaneInstance(state.config.layouts[0]!.layout, RESEARCH)?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });

    const back = appReducer(state, { type: "MOVE_PANE_BACK", paneId: LIST });
    expect(back.config.layout.dockRoot).toEqual(DOCK_ROOT);
    expect(findPaneInstance(back.config.layout, RESEARCH)?.binding).toEqual({ kind: "follow", sourceInstanceId: LIST });
  });

  test("docks a floating pane alone in the new layout, and Move Back floats it where it was", () => {
    const layout = threePaneLayout();
    layout.dockRoot = { kind: "split", axis: "horizontal", ratio: 0.5, first: { kind: "pane", instanceId: LIST }, second: { kind: "pane", instanceId: RESEARCH } };
    layout.floating = [{ instanceId: CHART, x: 12, y: 4, width: 50, height: 16, zIndex: 60 }];
    let state = stateWith([{ name: "Home", layout }]);

    state = moveToNewLayout(state, CHART);
    expect(state.config.layout.dockRoot).toEqual({ kind: "pane", instanceId: CHART });
    expect(state.config.layout.floating).toEqual([]);
    expect(state.config.layouts[0]!.layout.floating).toEqual([]);
    expect(state.config.layouts[0]!.layout.dockRoot).toEqual(layout.dockRoot);

    const back = appReducer(state, { type: "MOVE_PANE_BACK", paneId: CHART });
    expect(back.config.layout.dockRoot).toEqual(layout.dockRoot);
    expect(back.config.layout.floating).toEqual([expect.objectContaining({ instanceId: CHART, x: 12, y: 4, width: 50, height: 16 })]);
  });

  test("leaves a layout's only pane where it is", () => {
    const layout = threePaneLayout();
    const single: LayoutConfig = { ...layout, dockRoot: { kind: "pane", instanceId: CHART }, instances: [layout.instances[2]!] };
    const state = stateWith([{ name: "Home", layout: single }]);

    expect(moveToNewLayout(state, CHART)).toBe(state);
    expect(appReducer(state, { type: "MOVE_PANE_BACK", paneId: CHART })).toBe(state);
  });

  test("names each new layout apart from the ones there", () => {
    const layout = threePaneLayout();
    layout.instances.push(createPaneInstance("price-chart", { instanceId: "price-chart:nvda-2", binding: { kind: "fixed", symbol: "NVDA" } }));
    layout.dockRoot = { kind: "split", axis: "horizontal", ratio: 0.5, first: structuredClone(DOCK_ROOT), second: { kind: "pane", instanceId: "price-chart:nvda-2" } };
    let state = stateWith([{ name: "Home", layout }]);

    state = moveToNewLayout(state, CHART);
    state = appReducer(state, { type: "SWITCH_LAYOUT", index: 0 });
    state = moveToNewLayout(state, "price-chart:nvda-2");

    expect(state.config.layouts.map((entry) => entry.name)).toEqual(["Home", "Chart: NVDA", "Chart: NVDA (2)"]);
  });

  test("Move Back docks into the first other layout when the one it came from is gone", () => {
    let state = stateWith([
      { name: "Home", layout: threePaneLayout() },
      { name: "Research", layout: { ...threePaneLayout(), dockRoot: { kind: "pane", instanceId: LIST }, instances: [threePaneLayout().instances[0]!] } },
    ]);
    state = moveToNewLayout(state, CHART);
    state = appReducer(state, { type: "DELETE_LAYOUT", index: 0 });
    expect(state.config.layouts.map((entry) => entry.name)).toEqual(["Research", "Chart: NVDA"]);
    expect(paneMoveBackTarget(state.config, CHART)).toEqual({ index: 0, name: "Research", original: false });

    const back = appReducer(state, { type: "MOVE_PANE_BACK", paneId: CHART });

    expect(back.config.layouts.map((entry) => entry.name)).toEqual(["Research"]);
    expect(back.config.layout.dockRoot).toEqual({
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: LIST },
      second: { kind: "pane", instanceId: CHART },
    });
    expect(back.focusedPaneId).toBe(CHART);
  });
});
