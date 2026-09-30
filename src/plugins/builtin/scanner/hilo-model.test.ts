import { describe, expect, test } from "bun:test";
import { buildHiloBarRows, hiloBarLayout, hiloWindowLabel, HILO_LABEL_WIDTH, HILO_SIDE_NAME_WIDTH } from "./hilo-model";

const windows = {
  s30: { highs: 42, lows: 11 },
  m1: { highs: 118, lows: 37 },
  m5: { highs: 512, lows: 203 },
};

describe("hilo bar scaling", () => {
  test("scales every row against one shared maximum so the widest window dominates", () => {
    const rows = buildHiloBarRows(windows);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey.m5!.highRatio).toBe(1);
    expect(byKey.m1!.highRatio).toBeCloseTo(118 / 512, 6);
    expect(byKey.s30!.highRatio).toBeCloseTo(42 / 512, 6);
    // Lows share the same scale as highs, not a per-side one.
    expect(byKey.m5!.lowRatio).toBeCloseTo(203 / 512, 6);
  });

  test("returns zero ratios instead of dividing by zero on an empty session", () => {
    const rows = buildHiloBarRows({
      s30: { highs: 0, lows: 0 },
      m1: { highs: 0, lows: 0 },
      m5: { highs: 0, lows: 0 },
    });
    expect(rows.every((row) => row.highRatio === 0 && row.lowRatio === 0)).toBe(true);
    expect(buildHiloBarRows(null)).toHaveLength(3);
  });
});

describe("hilo bar labels", () => {
  test("centres every window label with at least two cells either side", () => {
    for (const label of ["5 min", "1 min", "30 sec"]) {
      const padded = hiloWindowLabel(label);
      expect(padded).toHaveLength(HILO_LABEL_WIDTH);
      expect(padded.trim()).toBe(label);
      expect(padded.indexOf(label)).toBeGreaterThanOrEqual(2);
      expect(HILO_LABEL_WIDTH - padded.indexOf(label) - label.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("names the sides only when the bars keep their room, and never overflows the row", () => {
    const wide = hiloBarLayout(80, 4);
    expect(wide.sideNameWidth).toBe(HILO_SIDE_NAME_WIDTH);
    expect(2 + 2 * (wide.sideNameWidth + wide.halfWidth) + HILO_LABEL_WIDTH).toBeLessThanOrEqual(80);
    expect(wide.barWidth).toBe(wide.halfWidth - 4);

    // The split tables' minimum width drops the names and gives the cells back to the bars.
    const narrow = hiloBarLayout(44, 4);
    expect(narrow.sideNameWidth).toBe(0);
    expect(2 + 2 * narrow.halfWidth + HILO_LABEL_WIDTH).toBeLessThanOrEqual(44);
    expect(narrow.barWidth).toBe(narrow.halfWidth - 4);
  });
});
