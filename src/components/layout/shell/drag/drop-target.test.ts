import { describe, expect, test } from "bun:test";
import type { DockLeafLayout, LayoutBounds } from "../../../../layout/pane-manager";
import { resolvePaneDropTarget } from "./index";

// Two docked panes side by side, a 3-row title bar each; edges catch within 1 cell.
const AREA = { x: 0, y: 0, width: 100, height: 40 };
const LEAVES: DockLeafLayout[] = [
  { instanceId: "a", path: [0], rect: { x: 0, y: 0, width: 50, height: 40 } },
  { instanceId: "b", path: [1], rect: { x: 50, y: 0, width: 50, height: 40 }, stack: ["b", "c"] },
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

describe("where a pane on the move lands", () => {
  test("over a title bar it becomes a tab there; over the body, away from the edges, it stays floating", () => {
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 })).toEqual({ kind: "tab", targetId: "a" });
    expect(target(20, 10, { x: 15, y: 9.5, width: 30, height: 12 })).toBeNull();
  });

  test("an edge pushed flush against the same edge of the pane under the pointer joins on that side", () => {
    expect(target(10, 10, { x: 0.6, y: 9.5, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "a", position: "left" });
    expect(target(40, 10, { x: 19.4, y: 9.5, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "a", position: "right" });
    expect(target(20, 30, { x: 15, y: 28, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "a", position: "bottom" });
    // Just out of reach: still floating.
    expect(target(10, 10, { x: 1.2, y: 9.5, width: 30, height: 12 })).toBeNull();
    // The closest edge wins when two are in reach.
    expect(target(10, 30, { x: 0.8, y: 27.9, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "a", position: "bottom" });
  });

  test("a window the screen's edge stops does not join for touching it, unless the pointer pushes past it", () => {
    // Too wide to go further right: drawn flush with b's right edge, but the
    // pointer would put it well past the screen.
    const held = { x: 40, y: 9.5, width: 60, height: 12 };
    expect(target(75, 10, held, { free: { ...held, x: 42 } })).toBeNull();
    // The pointer putting it within the catch: it joins.
    expect(target(75, 10, held, { free: { ...held, x: 40.6 } })).toEqual({ kind: "leaf", targetId: "b", position: "right" });
    // The pointer past the bottom of the dock area (on the status bar) joins below the pane there.
    const low = { x: 15, y: 28, width: 30, height: 12 };
    expect(target(20, 40.5, low, { free: { ...low, y: 32 } })).toEqual({ kind: "leaf", targetId: "a", position: "bottom" });
    // Past the top (on the top bar): above, not a tab.
    expect(target(70, -1, { x: 60, y: 0, width: 30, height: 12 })).toEqual({ kind: "leaf", targetId: "b", position: "top" });
  });

  test("Alt leaves the edges out but keeps the title bar", () => {
    expect(target(10, 10, { x: 0.6, y: 9.5, width: 30, height: 12 }, { join: false })).toBeNull();
    expect(target(70, -1, { x: 60, y: 0, width: 30, height: 12 }, { join: false })).toBeNull();
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 }, { join: false })).toEqual({ kind: "tab", targetId: "a" });
  });

  test("a tab of a stack can leave for a side of it, but is no tab to its own stack", () => {
    expect(target(70, 1, { x: 60, y: 0.5, width: 30, height: 12 }, { paneId: "c" })).toBeNull();
    expect(target(98, 10, { x: 69.5, y: 9.5, width: 30, height: 12 }, { paneId: "b" })).toEqual({ kind: "leaf", targetId: "c", position: "right" });
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 }, { paneId: "a" })).toBeNull();
  });
});
