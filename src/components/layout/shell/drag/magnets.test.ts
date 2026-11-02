import { describe, expect, test } from "bun:test";
import {
  createMagnetPace,
  MAGNET_REST_MS,
  magnetDistancesFor,
  NO_LATCH,
  snapMovedRect,
  snapResizedRect,
  type MagnetLatch,
} from "./magnets";

const AREA = { x: 0, y: 0, width: 200, height: 50 };
// The desktop's 8px catch and 12px release over 8 by 18 px cells.
const DESKTOP = magnetDistancesFor({ width: 8, height: 18 });
const NEIGHBOUR = { x: 100, y: 10, width: 40, height: 20 };

/** Moves a 30 by 12 window through `xs` (y fixed at 12), as a drag does, carrying the latch. */
function moveThrough(xs: number[], targets = [NEIGHBOUR]) {
  let latch: MagnetLatch = NO_LATCH;
  return xs.map((x) => {
    const snapped = snapMovedRect({ x, y: 12, width: 30, height: 12 }, targets, AREA, DESKTOP, latch);
    latch = snapped.latch;
    return snapped.rect.x;
  });
}

describe("magnets", () => {
  test("an edge within 8px of a neighbour's edge sticks to it, and lets go only past 12px", () => {
    // The window's right edge is at x + 30; the neighbour's left edge at 100.
    // 69.2 leaves 0.8 cells (6.4px): caught. 68.8 is 1.2 cells (9.6px) out:
    // held, since it was caught. 68.4 is 12.8px out: let go.
    expect(moveThrough([60, 69.2, 68.8, 68.4])).toEqual([60, 70, 70, 68.4]);
    // Coming the other way, 9.6px out is not close enough to catch.
    expect(moveThrough([60, 68.8])).toEqual([60, 68.8]);
  });

  test("edges line up with a neighbour beside them, but not with one far across the screen", () => {
    // Just under the neighbour: its top sticks to the neighbour's bottom, and
    // its left edge, 4.8px off, lines up with the neighbour's.
    expect(snapMovedRect({ x: 100.6, y: 30.2, width: 30, height: 10 }, [NEIGHBOUR], AREA, DESKTOP, NO_LATCH).rect)
      .toMatchObject({ x: 100, y: 30 });
    // The same x under a neighbour that ends 25 rows higher: nothing to line up with.
    const far = { ...NEIGHBOUR, y: 0, height: 5 };
    expect(snapMovedRect({ x: 100.6, y: 30.2, width: 30, height: 10 }, [far], AREA, DESKTOP, NO_LATCH).rect.x).toBe(100.6);
  });

  test("the edges of the area catch on both axes", () => {
    const snapped = snapMovedRect({ x: 0.5, y: 37.7, width: 30, height: 12 }, [], AREA, DESKTOP, NO_LATCH);
    expect(snapped.rect).toMatchObject({ x: 0, y: 38 });
  });

  test("a resize moves only the edge being dragged, and never under the minimum size", () => {
    const rect = { x: 60, y: 12, width: 39.4, height: 12 };
    // Dragging the right edge to 99.4: it sticks to the neighbour at 100, the left edge stays.
    expect(snapResizedRect(rect, { x: 1, y: 0 }, { width: 15, height: 6 }, [NEIGHBOUR], AREA, DESKTOP, NO_LATCH).rect)
      .toMatchObject({ x: 60, width: 40, y: 12, height: 12 });
    // Dragging the left edge: the neighbour's line is the right edge's business, so nothing moves.
    expect(snapResizedRect(rect, { x: -1, y: 0 }, { width: 15, height: 6 }, [NEIGHBOUR], AREA, DESKTOP, NO_LATCH).rect)
      .toMatchObject({ x: 60, width: 39.4 });
    // Pulling the right edge onto the area's would leave it under the minimum width: it stays.
    const narrow = { x: 0.6, y: 12, width: 15, height: 12 };
    expect(snapResizedRect(narrow, { x: 1, y: 0 }, { width: 15, height: 6 }, [], { ...AREA, width: 15.5 }, DESKTOP, NO_LATCH).rect.width).toBe(15);
  });

  test("a moving pane's magnets wait while the pointer travels, and catch once it slows down or rests", () => {
    const pace = createMagnetPace();
    // The first move of a drag leaves the spot the pane sits flush in.
    expect(pace.travelling({ t: 0, x: 10, y: 5 }, DESKTOP)).toBe(true);
    // Two cells (16px) a frame: 1,000 px/s.
    for (let frame = 1; frame <= 5; frame += 1) expect(pace.travelling({ t: frame * 16, x: 10 + frame * 2, y: 5 }, DESKTOP)).toBe(true);
    // Slowing to a quarter cell (2px) a frame, 125 px/s, as it nears where it goes.
    let travelling = true;
    for (let frame = 6; frame <= 12; frame += 1) travelling = pace.travelling({ t: frame * 16, x: 20 + (frame - 5) * 0.25, y: 5 }, DESKTOP);
    expect(travelling).toBe(false);
    // Off again, then still: the check after a rest (the same place, later) finds it placed.
    expect(pace.travelling({ t: 208, x: 26, y: 5 }, DESKTOP)).toBe(true);
    expect(pace.travelling({ t: 208 + MAGNET_REST_MS, x: 26, y: 5 }, DESKTOP)).toBe(false);
  });

  test("the rest check of a fast move never runs once a slower move has followed it", async () => {
    // A 60 Hz frame clock of its own: the check runs on the frame after the rest.
    const frames = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
    globalThis.requestAnimationFrame = ((run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 16)) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: ReturnType<typeof setTimeout>) => clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
    try {
      const pace = createMagnetPace();
      const rests: string[] = [];
      expect(pace.travelling({ t: 0, x: 10, y: 5 }, DESKTOP, () => rests.push("fast"))).toBe(true);
      // A cell in 64 ms is slow: the magnets act here, and nothing is left to run.
      expect(pace.travelling({ t: 64, x: 11, y: 5 }, DESKTOP, () => rests.push("slow"))).toBe(false);
      await Bun.sleep(MAGNET_REST_MS * 2);
      // Run, it would have put the pane back where the fast move left the pointer.
      expect(rests).toEqual([]);

      // Travelling, then still: it runs once.
      expect(pace.travelling({ t: 200, x: 30, y: 5 }, DESKTOP, () => rests.push("travel"))).toBe(true);
      await Bun.sleep(MAGNET_REST_MS * 2);
      expect(rests).toEqual(["travel"]);
    } finally {
      globalThis.requestAnimationFrame = frames.request;
      globalThis.cancelAnimationFrame = frames.cancel;
    }
  });

  test("the terminal catches at the next cell", () => {
    const terminal = magnetDistancesFor(null);
    expect(snapMovedRect({ x: 69, y: 12, width: 30, height: 12 }, [NEIGHBOUR], AREA, terminal, NO_LATCH).rect.x).toBe(70);
    expect(snapMovedRect({ x: 68, y: 12, width: 30, height: 12 }, [NEIGHBOUR], AREA, terminal, NO_LATCH).rect.x).toBe(68);
    // A desktop cell not measured yet catches as the terminal does, not at any distance.
    expect(magnetDistancesFor({ width: 0, height: 0 })).toEqual(terminal);
  });
});
