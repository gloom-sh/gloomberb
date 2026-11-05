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

const tab = (targetId: string) => ({ kind: "tab", targetId });
const side = (targetId: string, position: string) => ({ kind: "leaf", targetId, position });

describe("where a pane on the move would land", () => {
  test("over a title bar it becomes a tab there; over the body, away from the edges, it stays floating", () => {
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 })).toEqual({ tab: tab("a"), join: null });
    expect(target(20, 10, { x: 15, y: 9.5, width: 30, height: 12 })).toEqual({ tab: null, join: null });
  });

  test("an edge flush against the same edge of the pane under the pointer, where it meets another pane, joins on that side", () => {
    expect(target(40, 10, { x: 19.4, y: 9.5, width: 30, height: 12 }).join).toEqual(side("a", "right"));
    expect(target(60, 5, { x: 55, y: 7.6, width: 30, height: 12 }).join).toEqual(side("b", "bottom"));
    expect(target(60, 25, { x: 50.4, y: 24.5, width: 30, height: 12 }).join).toEqual(side("c", "left"));
    // Just out of reach: still floating.
    expect(target(40, 10, { x: 18.5, y: 9.5, width: 30, height: 12 }).join).toBeNull();
  });

  test("held by its title bar, a pane joins above a pane with the pointer on that pane's title bar, the tab only until the join holds", () => {
    expect(target(70, 21, { x: 60, y: 20.4, width: 30, height: 12 })).toEqual({ tab: tab("c"), join: side("c", "top") });
    // Its top edge short of c's: a tab.
    expect(target(70, 22, { x: 60, y: 21.5, width: 30, height: 12 })).toEqual({ tab: tab("c"), join: null });
  });

  test("with the title bars level, a side edge flush still joins on that side", () => {
    expect(target(25, 1, { x: 19.6, y: 0, width: 30, height: 12 })).toEqual({ tab: tab("a"), join: side("a", "right") });
    expect(target(55, 1, { x: 50.3, y: 0, width: 30, height: 12 })).toEqual({ tab: tab("b"), join: side("b", "left") });
    // In c's corner, its top edge flush too: the closer edge, the side when level.
    expect(target(55, 21, { x: 50.2, y: 20.5, width: 30, height: 12 }).join).toEqual(side("c", "left"));
    expect(target(55, 21, { x: 50, y: 20, width: 30, height: 12 }).join).toEqual(side("c", "left"));
  });

  test("laid squarely on a pane of its size, or across its whole width, it picks no side on that axis", () => {
    expect(target(60, 21, { x: 50, y: 20, width: 50, height: 20 })).toEqual({ tab: tab("c"), join: null });
    expect(target(60, 1, { x: 50.3, y: 0, width: 49.5, height: 20 })).toEqual({ tab: tab("b"), join: null });
    expect(target(60, 21, { x: 50, y: 20.2, width: 50, height: 12 })).toEqual({ tab: tab("c"), join: side("c", "top") });
  });

  test("a window parked at the screen's edge or corner stays floating", () => {
    expect(target(10, 10, { x: 0, y: 9.5, width: 30, height: 12 }).join).toBeNull();
    expect(target(90, 30, { x: 70, y: 28, width: 30, height: 12 }).join).toBeNull();
    expect(target(10, 30, { x: 0, y: 28, width: 30, height: 12 }).join).toBeNull();
    expect(target(10, 1, { x: 0, y: 0, width: 30, height: 12 })).toEqual({ tab: tab("a"), join: null });
    // The pointer off the dock area (on the top bar or the status bar) lands nowhere.
    expect(target(70, -1, { x: 60, y: 0, width: 30, height: 12 })).toEqual({ tab: null, join: null });
    expect(target(20, 40.5, { x: 15, y: 28, width: 30, height: 12 })).toEqual({ tab: null, join: null });
  });

  test("an edge the magnets hold flush while the pointer has moved on does not join", () => {
    const held = { x: 19.6, y: 9.5, width: 30, height: 12 };
    expect(target(40, 10, held, { free: { ...held, x: 17.5 } }).join).toBeNull();
    expect(target(40, 10, held, { free: { ...held, x: 19.1 } }).join).toEqual(side("a", "right"));
  });

  test("Alt leaves the edges out but keeps the title bar", () => {
    expect(target(40, 10, { x: 19.4, y: 9.5, width: 30, height: 12 }, { join: false })).toEqual({ tab: null, join: null });
    expect(target(70, 21, { x: 60, y: 20.4, width: 30, height: 12 }, { join: false })).toEqual({ tab: tab("c"), join: null });
  });

  test("a tab of a stack can leave it for a side of it, but is no tab to its own stack", () => {
    expect(target(70, 1, { x: 60, y: 0.5, width: 30, height: 12 }, { paneId: "d" })).toEqual({ tab: null, join: null });
    expect(target(60, 10, { x: 50.5, y: 6, width: 30, height: 12 }, { paneId: "b" }).join).toEqual(side("d", "left"));
    expect(target(20, 1, { x: 15, y: 0.5, width: 30, height: 12 }, { paneId: "a" })).toEqual({ tab: null, join: null });
  });
});
