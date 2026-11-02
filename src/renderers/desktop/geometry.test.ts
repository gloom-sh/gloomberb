import { describe, expect, test } from "bun:test";
import {
  arrangementKey,
  clampFrameToScreens,
  displayForFrame,
  displayFromKey,
  displayKey,
  isFrameReachable,
  isFrameVisible,
  moveFrameToDisplay,
  relocateFrame,
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

  test("on screen means all of it, across two screens or a shadow past an edge included", () => {
    expect(isFrameVisible({ x: 1300, y: 100, width: 800, height: 600 }, [laptop, right])).toBe(true);
    // The invisible resize border Windows counts in a frame.
    expect(isFrameVisible({ x: -7, y: 25, width: 800, height: 600 }, [laptop])).toBe(true);
    // Its title bar is on screen, most of it is not.
    expect(isFrameVisible({ x: 1300, y: 100, width: 800, height: 600 }, [laptop])).toBe(false);
    expect(isFrameVisible({ x: 100, y: 500, width: 800, height: 600 }, [laptop])).toBe(false);
  });

  test("a frame off every screen moves onto the nearest one, by as little as it takes", () => {
    // Electrobun leaves a window asked for at x 2200 on a 1920 screen off it.
    const hd = display("1", 0, 0, 1920, 1080, { primary: true, workArea: { x: 0, y: 0, width: 1920, height: 1040 } });
    expect(clampFrameToScreens({ x: 2200, y: 120, width: 1000, height: 700 }, [hd])).toEqual({
      x: 920, y: 120, width: 1000, height: 700,
    });
    expect(clampFrameToScreens({ x: -3000, y: 900, width: 1000, height: 700 }, [hd])).toEqual({
      x: 0, y: 340, width: 1000, height: 700,
    });
    // Most of it past the edge, its title bar still on: pulled in whole.
    expect(clampFrameToScreens({ x: 1300, y: 100, width: 800, height: 600 }, [laptop])).toEqual({
      x: 712, y: 100, width: 800, height: 600,
    });
    // Bigger than the screen: it shrinks to the work area.
    expect(clampFrameToScreens({ x: 100, y: -300, width: 3000, height: 2000 }, [laptop])).toEqual({
      x: 0, y: 25, width: 1512, height: 957,
    });
    const onScreen = { x: 1300, y: 100, width: 800, height: 600 };
    expect(clampFrameToScreens(onScreen, [laptop, right])).toBe(onScreen);
  });

  test("a window on a screen whose resolution changed stays on that screen", () => {
    const smaller = { ...right, bounds: { ...right.bounds, width: 1920, height: 1080 }, workArea: { x: 1512, y: -175, width: 1920, height: 1055 } };
    const frame = { x: 1512 + 2560 - 1000, y: -175, width: 1000, height: 700 };
    // Saved under the old screens: the display is known only by its key.
    const saved = displayFromKey(displayKey(right));
    const moved = relocateFrame(frame, saved, [laptop, smaller], laptop);
    // Still at the right edge, at the same size, inside the smaller work area.
    expect(moved).toMatchObject({ x: 1512 + 920, width: 1000, height: 700 });
    expect(moved.y).toBeGreaterThanOrEqual(smaller.workArea.y);
    expect(moved.y + moved.height).toBeLessThanOrEqual(smaller.workArea.y + smaller.workArea.height);
    // Unplugged: onto the fallback, at the same place in proportion.
    expect(relocateFrame(frame, saved, [laptop], laptop)).toMatchObject({ x: 512, width: 1000, height: 700 });
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
