import { describe, expect, test } from "bun:test";
import type { DockLeafLayout, LayoutBounds } from "../../../../layout/pane-manager";
import { resolvePaneDropTarget } from "./index";

// a on the left, b over c on the right (b a stack of b and d); a 3-row title
// bar each; edges catch within 1 cell. The panes meet at x 50 and, on the
// right, at y 20; every other edge is the screen's.
const AREA = { x: 0, y: 0, width: 100, height: 40 };
const LEAVES: DockLeafLayout[] = [
  { instanceId: "a", path: [0], rect: { x: 0, y: 0, width: 50, height: 40 } },
  { instanceId: "b", path: [1, 0], rect: { x: 50, y: 0, width: 50, height: 20 }, stack: ["b", "d"] },
  { instanceId: "c", path: [1, 1], rect: { x: 50, y: 20, width: 50, height: 20 } },
];

function target(
  x: number,
  y: number,
  rect: LayoutBounds,
  { paneId = "w", join = true, free = rect }: { paneId?: string; join?: boolean; free?: LayoutBounds } = {},
) {
  return resolvePaneDropTarget({
    x, y, rect, free, leaves: LEAVES, paneId, area: AREA,
    flush: { x: 1, y: 1 }, headerRows: 3, join,
  });
}

describe("where a pane on the move would land", () => {
  test("over a title bar it becomes a tab there; over the body, away from the edges, it stays floating", () => {
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 })).toEqual({ kind: "tab", targetId: "a" });
    expect(target(20, 10, { x: 15, y: 9.5, width: 30, height: 12 })).toBeNull();
  });

  test("an edge flush against the same edge of the pane under the pointer, where it meets another pane, joins on that side", () => {
    expect(target(40, 10, { x: 19.4, y: 9.5, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "a", position: "right" });
    expect(target(60, 5, { x: 55, y: 7.6, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "b", position: "bottom" });
    expect(target(60, 25, { x: 50.4, y: 24.5, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "c", position: "left" });
    // Just out of reach: still floating.
    expect(target(40, 10, { x: 18.5, y: 9.5, width: 30, height: 12 })).toBeNull();
  });

  test("a window parked at the screen's edge or corner stays floating", () => {
    expect(target(10, 10, { x: 0, y: 9.5, width: 30, height: 12 })).toBeNull();
    expect(target(90, 30, { x: 70, y: 28, width: 30, height: 12 })).toBeNull();
    expect(target(10, 30, { x: 0, y: 28, width: 30, height: 12 })).toBeNull();
    // The pointer off the dock area (on the top bar or the status bar) lands nowhere.
    expect(target(70, -1, { x: 60, y: 0, width: 30, height: 12 })).toBeNull();
    expect(target(20, 40.5, { x: 15, y: 28, width: 30, height: 12 })).toBeNull();
  });

  test("an edge the magnets hold flush while the pointer has moved on does not join", () => {
    const held = { x: 19.6, y: 9.5, width: 30, height: 12 };
    expect(target(40, 10, held, { free: { ...held, x: 17.5 } })).toBeNull();
    expect(target(40, 10, held, { free: { ...held, x: 19.1 } })).toEqual({ kind: "leaf", targetId: "a", position: "right" });
  });

  test("Alt leaves the edges out but keeps the title bar", () => {
    expect(target(40, 10, { x: 19.4, y: 9.5, width: 30, height: 12 }, { join: false })).toBeNull();
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 }, { join: false })).toEqual({ kind: "tab", targetId: "a" });
  });

  test("a tab of a stack can leave it for a side of it, but is no tab to its own stack", () => {
    expect(target(70, 1, { x: 60, y: 0.5, width: 30, height: 12 }, { paneId: "d" })).toBeNull();
    expect(target(60, 10, { x: 50.5, y: 6, width: 30, height: 12 }, { paneId: "b" })).toEqual({ kind: "leaf", targetId: "d", position: "left" });
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 }, { paneId: "a" })).toBeNull();
  });
});
