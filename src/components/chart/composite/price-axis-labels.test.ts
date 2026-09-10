import { describe, expect, test } from "bun:test";
import { buildCursorPriceAxisOverlay } from "./price-axis-labels";

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
