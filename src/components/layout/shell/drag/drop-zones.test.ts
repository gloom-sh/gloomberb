import { describe, expect, test } from "bun:test";
import {
  desktopDropZoneMetrics,
  dropZoneSquares,
  resolveDropZone,
  TERMINAL_DROP_ZONE_METRICS,
  type DropZoneHost,
} from "./drop-zones";

// 8 x 16 px cells: a square of the target is 4.5 cells wide and 2.25 rows tall, the strips 1.5 cells and 0.75 rows deep.
const DESKTOP = desktopDropZoneMetrics({ width: 8, height: 16 });
const AREA = { x: 0, y: 0, width: 100, height: 40 };
const floating: DropZoneHost = { id: "f", rect: { x: 10, y: 5, width: 30, height: 20 }, docked: false };
const docked: DropZoneHost = { id: "d", rect: { x: 0, y: 0, width: 50, height: 40 }, docked: true };

const zoneAt = (x: number, y: number, metrics = DESKTOP) => resolveDropZone({ x, y, hosts: [floating, docked], area: AREA, metrics });

describe("the drop target under the pointer", () => {
  test("over a pane, each square of its target is what a release there does; off the squares the pane floats", () => {
    const squares = dropZoneSquares(floating.rect, DESKTOP);
    const middle = (side: keyof typeof squares) => [squares[side].x + 1, squares[side].y + 1] as const;
    expect(zoneAt(...middle("center"))).toEqual({ host: floating, side: "center", edge: null });
    for (const side of ["left", "right", "top", "bottom"] as const) expect(zoneAt(...middle(side)).side).toBe(side);
    expect(zoneAt(12, 7)).toEqual({ host: floating, side: null, edge: null });
    // Past every pane and strip: nothing, the pane floats.
    expect(zoneAt(80, 20)).toEqual({ host: null, side: null, edge: null });
  });

  test("the front pane takes the pointer; a pane of the layout shows its target where no window covers it", () => {
    expect(zoneAt(45, 30).host).toBe(docked);
    expect(zoneAt(20, 10).host).toBe(floating);
  });

  test("the strips along the window's edges come first, past the edge too, the nearer edge in a corner", () => {
    expect(zoneAt(1, 20).edge).toBe("left");
    expect(zoneAt(60, -2).edge).toBe("top");
    expect(zoneAt(99.5, 39).edge).toBe("right");
    expect(zoneAt(60, 39.6).edge).toBe("bottom");
    expect(zoneAt(1.4, 0.5).edge).toBe("top");
  });

  test("terminal: the squares sit on whole cells, the strips are the outermost cell, the pointer a cell", () => {
    const squares = dropZoneSquares({ x: 10, y: 5, width: 31, height: 20 }, TERMINAL_DROP_ZONE_METRICS);
    expect(squares.center).toEqual({ x: 24, y: 14, width: 3, height: 1 });
    expect(squares.left).toEqual({ x: 20, y: 14, width: 3, height: 1 });
    expect(squares.top).toEqual({ x: 24, y: 13, width: 3, height: 1 });
    expect(zoneAt(0, 20, TERMINAL_DROP_ZONE_METRICS).edge).toBe("left");
    expect(zoneAt(1, 20, TERMINAL_DROP_ZONE_METRICS).edge).toBeNull();
    expect(zoneAt(99, 20, TERMINAL_DROP_ZONE_METRICS).edge).toBe("right");
    expect(zoneAt(98, 20, TERMINAL_DROP_ZONE_METRICS).edge).toBeNull();
    expect(zoneAt(60, 39, TERMINAL_DROP_ZONE_METRICS).edge).toBe("bottom");
  });
});
