import { expect, test } from "bun:test";
import { autoOverviewChartScale, toggledOverviewChartScale } from "./chart-scale";

const closes = (...values: Array<number | null>) => values.map((value) => ({ value }));

test("a history whose highest close is 3x its lowest or more opens on a log axis; a narrower one, or one at zero or below, stays linear", () => {
  expect(autoOverviewChartScale(closes(40, 80, 119.9))).toBe("linear");
  expect(autoOverviewChartScale(closes(40, 80, 120))).toBe("log");
  // A gap in the history is no low.
  expect(autoOverviewChartScale(closes(null, 0.5, Number.NaN, 140))).toBe("log");
  // A log axis cannot place a close at zero or below (oil in April 2020, a negative yield).
  expect(autoOverviewChartScale(closes(-37.6, 20, 140))).toBe("linear");
  expect(autoOverviewChartScale(closes(0, 20, 140))).toBe("linear");
  expect(autoOverviewChartScale(closes())).toBe("linear");
  // A yield index's level is a rate, not a price that compounds.
  expect(autoOverviewChartScale(closes(0.5, 15.8), { rate: true })).toBe("linear");
});

test("switching the scale is kept as a choice until it matches what the history calls for, which is auto again", () => {
  // A wide history opens on log: switching shows linear and keeps it, switching back is auto.
  expect(toggledOverviewChartScale("auto", "log")).toBe("linear");
  expect(toggledOverviewChartScale("linear", "log")).toBe("auto");
  // A narrow one opens on linear: switching keeps log, and back is auto.
  expect(toggledOverviewChartScale("auto", "linear")).toBe("log");
  expect(toggledOverviewChartScale("log", "linear")).toBe("auto");
  // A choice made on another ticker holds here, and switching from it moves to the other scale.
  expect(toggledOverviewChartScale("linear", "linear")).toBe("log");
  expect(toggledOverviewChartScale("log", "log")).toBe("linear");
});
