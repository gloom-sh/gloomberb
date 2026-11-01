import { describe, expect, test } from "bun:test";
import {
  arrangementKey,
  displayForFrame,
  fitFrameToDisplays,
  isFrameReachable,
  moveFrameToDisplay,
  type DesktopDisplay,
} from "./geometry";

function display(id: string, x: number, y: number, width: number, height: number, options: Partial<DesktopDisplay> = {}): DesktopDisplay {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y: y + 25, width, height: height - 25 },
    scaleFactor: 2,
    primary: false,
    ...options,
  };
}

const laptop = display("1", 0, 0, 1512, 982, { primary: true });
const right = display("2", 1512, -200, 2560, 1440, { scaleFactor: 1 });

describe("arrangement key", () => {
  test("ignores the shell's ids and the order displays are listed in", () => {
    const again = { ...right, id: "77" };
    expect(arrangementKey([laptop, right])).toBe(arrangementKey([again, { ...laptop, id: "9" }]));
  });

  test("changes with a display's place, size or scale", () => {
    const base = arrangementKey([laptop, right]);
    expect(arrangementKey([laptop])).not.toBe(base);
    expect(arrangementKey([laptop, { ...right, bounds: { ...right.bounds, x: -2560 } }])).not.toBe(base);
    expect(arrangementKey([laptop, { ...right, scaleFactor: 2 }])).not.toBe(base);
  });
});

describe("frames on displays", () => {
  test("a window belongs to the display holding its centre", () => {
    expect(displayForFrame({ x: 1400, y: 100, width: 800, height: 600 }, [laptop, right])?.id).toBe("2");
    expect(displayForFrame({ x: 9000, y: 100, width: 800, height: 600 }, [laptop, right])).toBeNull();
  });

  test("a window is reachable while a stretch of its title bar is in a work area", () => {
    expect(isFrameReachable({ x: 100, y: 100, width: 800, height: 600 }, [laptop])).toBe(true);
    // Above the menu bar: nothing to grab.
    expect(isFrameReachable({ x: 100, y: -40, width: 800, height: 600 }, [laptop])).toBe(false);
    expect(isFrameReachable({ x: 1480, y: 100, width: 800, height: 600 }, [laptop])).toBe(false);
  });

  test("a frame off every display lands on the primary one, at its left edge", () => {
    expect(fitFrameToDisplays({ x: 3000, y: 300, width: 800, height: 500 }, [laptop])).toEqual({
      x: 0, y: 300, width: 800, height: 500,
    });
    expect(fitFrameToDisplays({ x: 100, y: -300, width: 3000, height: 2000 }, [laptop])).toEqual({
      x: 0, y: 25, width: 1512, height: 957,
    });
  });

  test("moving to another display keeps the place in proportion", () => {
    // Right half of the big display, top: right half of the laptop, top.
    const frame = { x: 1512 + 2560 - 1000, y: -175, width: 1000, height: 700 };
    expect(moveFrameToDisplay(frame, right, laptop)).toEqual({ x: 512, y: 25, width: 1000, height: 700 });
    // Too big for the laptop: it shrinks to the work area.
    expect(moveFrameToDisplay({ ...frame, width: 2000, height: 1400 }, right, laptop)).toEqual({
      x: 0, y: 25, width: 1512, height: 957,
    });
  });
});
