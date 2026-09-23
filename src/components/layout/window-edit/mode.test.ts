import { describe, expect, test } from "bun:test";
import type { LayoutConfig } from "../../../types/config";
import {
  cycleWindowEditPane,
  cycleWindowEditTarget,
  getWindowEditPaneIds,
  snapPositionFromWindowEditKey,
  snapWindowEditPane,
  type WindowEditState,
} from "./mode";
import { resolveWindowEditDockMovePreview, windowEditHelpItems } from "./presentation";
import { wrapWindowEditHelp } from "./status";

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

  test("a snap key floats the window at that quarter and keeps its place in the stack", () => {
    const layout: LayoutConfig = {
      dockRoot: { kind: "pane", instanceId: "dock-a" },
      instances: [pane("dock-a"), pane("float-a"), pane("float-b")],
      floating: [
        { instanceId: "float-a", x: 4, y: 2, width: 30, height: 8, zIndex: 50 },
        { instanceId: "float-b", x: 8, y: 4, width: 30, height: 8, zIndex: 75 },
      ],
      detached: [],
    };
    const state: WindowEditState = { paneId: "float-a", previewLayout: layout, mode: "move", focus: { kind: "move" }, dirty: false };

    expect(snapPositionFromWindowEditKey({ name: "2" })).toBe("top-right");
    expect(snapPositionFromWindowEditKey({ name: "9" })).toBeNull();
    const next = snapWindowEditPane(state, { x: 60, y: 0, width: 60, height: 20 }, bounds, {});

    expect(next.dirty).toBe(true);
    expect(next.previewLayout.floating.find((entry) => entry.instanceId === "float-a"))
      .toMatchObject({ x: 60, y: 0, width: 60, height: 20, zIndex: 50 });
  });

  // Leaving window mode is what a cut-off help line must never lose.
  test("the help panel keeps Enter and Esc and cuts the least used keys", () => {
    const state: WindowEditState = {
      paneId: "dock-a",
      previewLayout: { dockRoot: { kind: "pane", instanceId: "dock-a" }, instances: [pane("dock-a")], floating: [], detached: [] },
      mode: "move",
      focus: { kind: "move" },
      dirty: true,
    };
    const lines = wrapWindowEditHelp(windowEditHelpItems(state, true), 30, 2);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith("Enter apply  Esc cancel");
    expect(lines.every((line) => line.length <= 30)).toBe(true);
    expect(lines[1]).toEndWith("...");
  });
});
