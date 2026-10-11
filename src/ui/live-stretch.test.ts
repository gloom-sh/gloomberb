import { describe, expect, test } from "bun:test";
import { learnStretchAxis, predictStretchAxis, startStretchAxis } from "./live-stretch";

/** A chart that renders at whole cells, `gutter` short of a pane of `pane` (fractional) cells. */
const across = (pane: number, gutter = 0) => Math.floor(pane) - gutter;

describe("live stretch", () => {
  test("keeps its share of the pane until it has rendered at another size", () => {
    const axis = startStretchAxis(80, 40);
    expect(axis.slope).toBe(0.5);
    // Two cells of travel say nothing yet.
    expect(learnStretchAxis(axis, 82, 41)).toBe(axis);
    expect(predictStretchAxis(axis, 80, 40, 90)).toBe(45);
  });

  test("a surface across the pane follows the frame cell for cell, whole-cell rounding and all", () => {
    let axis = startStretchAxis(72, across(72, 1));
    for (const pane of [75.4, 79.9, 88.6, 70.2, 61.7]) {
      axis = learnStretchAxis(axis, pane, across(pane, 1));
      expect(axis.slope).toBe(1);
    }
    // From its last render at 61.7 cells (60 drawn), the frame is now at 66.2.
    expect(predictStretchAxis(axis, 61.7, 60, 66.2)).toBeCloseTo(64.5);
  });

  test("a chart of a fixed height in a column of text stays put", () => {
    const axis = learnStretchAxis(startStretchAxis(40, 12), 49.3, 12);
    expect(axis.slope).toBe(0);
    expect(predictStretchAxis(axis, 49.3, 12, 60)).toBe(12);
  });

  test("a surface beside another takes its part of the frame's travel", () => {
    // Half the pane: 40 of 80 cells, then 50 of 100.
    const axis = learnStretchAxis(startStretchAxis(80, 40), 100, 50);
    expect(axis.slope).toBe(0.5);
    expect(predictStretchAxis(axis, 100, 50, 90)).toBe(45);
  });

  test("never draws below nothing", () => {
    expect(predictStretchAxis(startStretchAxis(20, 20), 20, 20, -5)).toBe(0);
  });
});
