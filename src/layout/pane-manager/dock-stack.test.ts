import { describe, expect, test } from "bun:test";
import {
  buildDockStack,
  normalizePaneLayout,
  type DockLayoutNode,
  type LayoutConfig,
} from "../../types/config";
import {
  applyDrop,
  dockPane,
  floatAtRect,
  getDockedPaneIds,
  getDockLeafLayouts,
  gridlockAllPanes,
  removePane,
  restoreHiddenPanes,
  showDockTab,
} from "./index";
import { finalizeLayout } from "./layout-state";

const BOUNDS = { x: 0, y: 0, width: 120, height: 40 };
const pane = (instanceId: string): DockLayoutNode => ({ kind: "pane", instanceId });
const split = (first: DockLayoutNode, second: DockLayoutNode, axis: "horizontal" | "vertical" = "horizontal"): DockLayoutNode => (
  { kind: "split", axis, ratio: 0.5, first, second }
);

function layoutOf(dockRoot: DockLayoutNode | null, ids: string[]): LayoutConfig {
  return {
    dockRoot,
    instances: ids.map((instanceId) => ({ instanceId, paneId: "chat", binding: { kind: "none" } })),
    floating: [],
    detached: [],
  };
}

/** The spots on screen: each pane, or a stack as "shown[tab,tab]". */
function spots(layout: LayoutConfig): string[] {
  return getDockLeafLayouts(layout, BOUNDS).map((leaf) => (
    leaf.stack ? `${leaf.instanceId}[${leaf.stack.join(",")}]` : leaf.instanceId
  ));
}

describe("stacked tabs in the dock", () => {
  test("a pane dropped on another's title bar becomes its shown tab, in its spot", () => {
    const layout = layoutOf(split(pane("a"), split(pane("b"), pane("c"), "vertical")), ["a", "b", "c"]);
    const next = applyDrop(layout, "c", { kind: "tab", targetId: "a" });

    expect(spots(next)).toEqual(["c[a,c]", "b"]);
    const [stack, rest] = getDockLeafLayouts(next, BOUNDS);
    // The stack keeps the spot a had; b takes the room c left.
    expect(stack!.rect.width).toBe(60);
    expect(rest!.rect).toMatchObject({ x: 60, height: 40 });
    // Every tab is still docked, so none of them is pruned.
    expect(getDockedPaneIds(next).sort()).toEqual(["a", "b", "c"]);
  });

  test("the centre drop stacks instead of swapping", () => {
    const layout = layoutOf(split(pane("a"), pane("b")), ["a", "b"]);
    expect(spots(applyDrop(layout, "b", { kind: "leaf", targetId: "a", position: "center" }))).toEqual(["b[a,b]"]);
  });

  test("a tab that leaves shows the next one, and a stack of one is a plain pane again", () => {
    const layout = layoutOf(split(buildDockStack(["a", "b", "c"], "b")!, pane("d")), ["a", "b", "c", "d"]);

    const floated = floatAtRect(layout, "b", { x: 10, y: 5, width: 40, height: 12 });
    expect(spots(floated)).toEqual(["c[a,c]", "d"]);
    expect(floated.floating.map((entry) => entry.instanceId)).toEqual(["b"]);

    const closed = removePane(removePane(layout, "a"), "c");
    expect(spots(closed)).toEqual(["b", "d"]);
    expect(closed.dockRoot).toEqual(split(pane("b"), pane("d")));
  });

  test("joining beside a tab splits beside the whole stack", () => {
    const layout = layoutOf(split(buildDockStack(["a", "b"], "a")!, pane("c")), ["a", "b", "c"]);
    const next = applyDrop(layout, "c", { kind: "leaf", targetId: "b", position: "bottom" });

    expect(spots(next)).toEqual(["a[a,b]", "c"]);
    const [stack, joined] = getDockLeafLayouts(next, BOUNDS);
    expect(stack!.rect).toMatchObject({ y: 0, width: 120 });
    expect(joined!.rect.y).toBeGreaterThan(stack!.rect.y);
  });

  test("focus shows a tab, and a tab floated and docked again goes back into its stack", () => {
    // Every edit finalizes, which records where each pane was docked.
    const layout = finalizeLayout(layoutOf(split(buildDockStack(["a", "b"], "a")!, pane("c")), ["a", "b", "c"]));
    expect(spots(showDockTab(layout, "b"))).toEqual(["b[a,b]", "c"]);
    expect(showDockTab(layout, "a")).toBe(layout);

    const floated = floatAtRect(layout, "b", { x: 10, y: 5, width: 40, height: 12 });
    expect(spots(floated)).toEqual(["a", "c"]);
    expect(spots(dockPane(floated, "b"))).toEqual(["b[a,b]", "c"]);
  });

  test("a stack reads back whole, nested or with a stale tab, and a build before tabs keeps every pane", () => {
    // A pane put back inside a stack (its remembered spot) is one more tab.
    const nested: DockLayoutNode = { ...buildDockStack(["a", "b"], "gone")!, second: split(pane("b"), pane("c"), "vertical") } as DockLayoutNode;
    const normalized = normalizePaneLayout(layoutOf(split(nested, pane("d")), ["a", "b", "c", "d"]));
    expect(spots(normalized)).toEqual(["a[a,b,c]", "d"]);

    // An older build drops the marks and reads the chain as panes side by side.
    const stripped = JSON.parse(JSON.stringify(normalized.dockRoot), (key, value) => (key === "tabs" ? undefined : value));
    const older = normalizePaneLayout(layoutOf(stripped, ["a", "b", "c", "d"]));
    expect(spots(older).sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("a hidden tab goes back into its stack, and tidying keeps the tabs", () => {
    const saved = layoutOf(split(buildDockStack(["a", "b", "c"], "a")!, pane("d")), ["a", "b", "c", "d"]);
    const shown = removePane(saved, "b");
    expect(spots(shown)).toEqual(["a[a,c]", "d"]);
    const edited = applyDrop(shown, "d", { kind: "leaf", targetId: "a", position: "top" });
    const restored = restoreHiddenPanes(saved, edited, (instance) => instance.instanceId === "b");
    expect(spots(normalizePaneLayout(restored))).toEqual(["d", "a[a,c,b]"]);

    expect(spots(gridlockAllPanes(saved, BOUNDS))).toEqual(["a[a,b,c]", "d"]);
  });
});
