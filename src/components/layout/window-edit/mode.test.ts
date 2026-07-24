import { describe, expect, test } from "bun:test";
import type { LayoutConfig } from "../../../types/config";
import {
  applyWindowEditDirection,
  cycleWindowEditFocus,
  cycleWindowEditPane,
  cycleWindowEditTarget,
  getWindowEditPaneIds,
  type WindowEditState,
} from "./mode";
import { resolveWindowEditDockMovePreview } from "./presentation";

const bounds = { x: 0, y: 0, width: 120, height: 40 };

function pane(instanceId: string, paneId = "test-pane") {
  return { instanceId, paneId };
}

describe("window edit mode", () => {
  test("keeps window cycling independent from floating z-index changes", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "dock-a" },
        second: { kind: "pane", instanceId: "dock-b" },
      },
      instances: [
        pane("dock-a"),
        pane("dock-b"),
        pane("float-a"),
        pane("float-b"),
      ],
      floating: [
        { instanceId: "float-a", x: 4, y: 2, width: 30, height: 8, zIndex: 50 },
        { instanceId: "float-b", x: 8, y: 4, width: 30, height: 8, zIndex: 75 },
      ],
      detached: [],
    };
    let state: WindowEditState = {
      paneId: "dock-a",
      previewLayout: layout,
      mode: "move",
      focus: { kind: "move" },
      dirty: false,
    };

    state = cycleWindowEditPane(state, getWindowEditPaneIds(state.previewLayout, bounds, {}), bounds, {}, 1);
    expect(state.paneId).toBe("dock-b");

    state = cycleWindowEditPane(state, getWindowEditPaneIds(state.previewLayout, bounds, {}), bounds, {}, 1);
    expect(state.paneId).toBe("float-a");
    expect(state.previewLayout.floating.find((entry) => entry.instanceId === "float-a")?.zIndex)
      .toBeGreaterThan(state.previewLayout.floating.find((entry) => entry.instanceId === "float-b")?.zIndex ?? 0);

    state = cycleWindowEditPane(state, getWindowEditPaneIds(state.previewLayout, bounds, {}), bounds, {}, 1);
    expect(state.paneId).toBe("float-b");

    state = cycleWindowEditPane(state, getWindowEditPaneIds(state.previewLayout, bounds, {}), bounds, {}, 1);
    expect(state.paneId).toBe("dock-a");
  });

  test("cycles dock move targets without changing the selected window", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "source" },
        second: {
          kind: "split",
          axis: "vertical",
          ratio: 0.5,
          first: { kind: "pane", instanceId: "target-a" },
          second: { kind: "pane", instanceId: "target-b" },
        },
      },
      instances: [
        pane("source"),
        pane("target-a"),
        pane("target-b"),
      ],
      floating: [],
      detached: [],
    };
    const state: WindowEditState = {
      paneId: "source",
      previewLayout: layout,
      mode: "move",
      focus: { kind: "dock-move", targetId: "target-a", position: "right" },
      dirty: false,
    };

    const next = cycleWindowEditTarget(state, bounds, { reserveDividerGutters: true }, 1);

    expect(next.paneId).toBe("source");
    expect(next.focus).toEqual({ kind: "dock-move", targetId: "target-b", position: "right" });
  });

  test("uses dock geometry options for dock move preview rectangles", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "left" },
        second: { kind: "pane", instanceId: "right" },
      },
      instances: [
        pane("left"),
        pane("right"),
      ],
      floating: [],
      detached: [],
    };
    const state: WindowEditState = {
      paneId: "left",
      previewLayout: layout,
      mode: "move",
      focus: { kind: "dock-move", targetId: "right", position: "right" },
      dirty: false,
    };

    expect(resolveWindowEditDockMovePreview(state, bounds, { reserveDividerGutters: true })?.rect)
      .toEqual({ x: 61, y: 0, width: 59, height: 40 });
  });

  test("resizes floating panes from an edge and a corner", () => {
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [pane("float-a")],
      floating: [{ instanceId: "float-a", x: 20, y: 8, width: 40, height: 14, zIndex: 50 }],
      detached: [],
    };
    const edgeState: WindowEditState = {
      paneId: "float-a",
      previewLayout: layout,
      mode: "resize",
      focus: { kind: "floating-resize", corner: "right" },
      dirty: false,
    };

    const edgeNext = applyWindowEditDirection(edgeState, "right", false, bounds, {});
    expect(edgeNext.previewLayout.floating[0]).toEqual(expect.objectContaining({
      x: 20,
      y: 8,
      width: 42,
      height: 14,
    }));
    expect(edgeNext.dirty).toBe(true);

    let cornerNext = applyWindowEditDirection({
      ...edgeState,
      focus: { kind: "floating-resize", corner: "bottom-left" },
    }, "left", false, bounds, {});
    cornerNext = applyWindowEditDirection(cornerNext, "down", false, bounds, {});
    expect(cornerNext.previewLayout.floating[0]).toEqual(expect.objectContaining({
      x: 18,
      y: 8,
      width: 42,
      height: 15,
    }));
    expect(cornerNext.dirty).toBe(true);
  });

  test("resizes a small snapped pane without applying ordinary float minimums", () => {
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [pane("float-a")],
      floating: [{
        instanceId: "float-a",
        x: 20,
        y: 8,
        width: 6,
        height: 3,
        zIndex: 50,
        fixedGeometry: true,
      }],
      detached: [],
    };
    const state: WindowEditState = {
      paneId: "float-a",
      previewLayout: layout,
      mode: "resize",
      focus: { kind: "floating-resize", corner: "bottom-right" },
      dirty: false,
    };

    const next = applyWindowEditDirection(state, "right", false, bounds, {});

    expect(next.previewLayout.floating[0]).toEqual({
      instanceId: "float-a",
      x: 20,
      y: 8,
      width: 8,
      height: 3,
      zIndex: 50,
      fixedGeometry: true,
    });
    expect(next.dirty).toBe(true);
  });

  test("cycles through all eight floating resize handles", () => {
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [pane("float-a")],
      floating: [{ instanceId: "float-a", x: 20, y: 8, width: 40, height: 14, zIndex: 50 }],
      detached: [],
    };
    const expectedCorners = [
      "top-left",
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
    ] as const;
    let focus: WindowEditState["focus"] = { kind: "floating-resize", corner: "top-left" };
    const visited = [focus.corner];

    for (let index = 1; index < expectedCorners.length; index += 1) {
      focus = cycleWindowEditFocus(focus, layout, "float-a", "resize", bounds, {}, 1);
      expect(focus.kind).toBe("floating-resize");
      if (focus.kind === "floating-resize") visited.push(focus.corner);
    }

    expect(visited).toEqual([...expectedCorners]);
    expect(cycleWindowEditFocus(focus, layout, "float-a", "resize", bounds, {}, 1))
      .toEqual({ kind: "floating-resize", corner: "top-left" });
  });
});
