import { describe, expect, test } from "bun:test";
import { buildCursorPriceAxisOverlay, placeAxisTicks } from "./price-axis-labels";

describe("buildCursorPriceAxisOverlay", () => {
  test("positions desktop cursor y-axis overlay from exact pixels", () => {
    const height = 8;
    const cellHeightPx = 18;
    const cursorPixelY = 45.25;
    const overlay = buildCursorPriceAxisOverlay({
      axisWidth: 7,
      axisSectionWidth: 8,
      height,
      cursorPixelY,
      cursorLabel: "$214.03",
      cellHeightPx,
    });

    expect(overlay.labelText).toBe("$214.03");
    expect(overlay.topPercent).toBeCloseTo((cursorPixelY / (height * cellHeightPx - 1)) * 100, 5);

    // An extreme value or a narrow pane must not present a partial amount or
    // lose its trailing currency. The full value remains in the chart legend.
    for (const cursorLabel of ["$90.01B", "-123.46M CAD", "$1,234,567.89"]) {
      expect(buildCursorPriceAxisOverlay({
        axisWidth: 4, axisSectionWidth: 5, height, cursorPixelY, cursorLabel, cellHeightPx,
      }).labelText).toBe("…");
    }
  });
});

describe("placeAxisTicks", () => {
  const ticks = [
    { ratio: 0, label: "1.5M" },
    { ratio: 1 / 3, label: "1.0M" },
    { ratio: 2 / 3, label: "500K" },
    { ratio: 1, label: "0" },
  ];
  const labels = (placed: ReturnType<typeof placeAxisTicks>) => placed.map((tick) => tick.label);

  test("thins a short panel to labels a line apart, keeping top and bottom", () => {
    // 3 rows of 18px: the ticks are 17px apart, closer than a line of text.
    expect(labels(placeAxisTicks({ ticks, height: 3, cellHeightPx: 18 }))).toEqual(["1.5M", "0"]);
    expect(labels(placeAxisTicks({ ticks, height: 6, cellHeightPx: 18 }))).toEqual(["1.5M", "1.0M", "500K", "0"]);
  });

  test("gives way to the cursor or an anchor badge within a line of it", () => {
    const placed = placeAxisTicks({ ticks, height: 6, cellHeightPx: 18, badgeCentersPx: [40] });
    expect(labels(placed)).toEqual(["1.5M", "500K", "0"]);
  });
});
