import { describe, expect, test } from "bun:test";
import { buildHiloBarRows, terminalBarCells } from "./hilo-model";

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

  test("converts ratios to cells at half-cell resolution and never overflows the half width", () => {
    expect(terminalBarCells(1, 20)).toEqual({ full: 20, half: false });
    expect(terminalBarCells(0.5, 20)).toEqual({ full: 10, half: false });
    expect(terminalBarCells(0.525, 20)).toEqual({ full: 10, half: true });
    expect(terminalBarCells(2, 20)).toEqual({ full: 20, half: false });
  });

  test("keeps a nonzero count visible as a half cell instead of rounding it away", () => {
    expect(terminalBarCells(42 / 512, 20)).toEqual({ full: 1, half: true });
    expect(terminalBarCells(0.001, 20)).toEqual({ full: 0, half: true });
    expect(terminalBarCells(0, 20)).toEqual({ full: 0, half: false });
  });
});
