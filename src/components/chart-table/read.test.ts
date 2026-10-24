import { expect, test } from "bun:test";
import { CHART_READ_MAX_ROWS, chartReadLines } from "./read";

const READ = "Education and communication moved the 0.6% rise by less than 0.01 points and is 5.0% of the basket.";

test("a read that fits the pane stays on one row, whole", () => {
  expect(chartReadLines(READ, READ.length + 2)).toEqual([READ]);
});

test("a longer read wraps at words, every word kept in order", () => {
  const lines = chartReadLines(READ, 62);
  expect(lines).toEqual(["Education and communication moved the 0.6% rise by less than", "0.01 points and is 5.0% of the basket."]);
  expect(lines.every((line) => line.length <= 60)).toBe(true);
});

test("past the row cap the last row ends in an ellipsis instead of dropping words silently", () => {
  const lines = chartReadLines(READ, 30);
  expect(lines).toHaveLength(CHART_READ_MAX_ROWS);
  expect(lines).toEqual(["Education and communication", "moved the 0.6% rise by less", "than 0.01 points and is 5..."]);
  // Three rows hold the whole sentence at a width a little wider; nothing is cut then.
  expect(chartReadLines(READ, 50).join(" ")).toBe(READ);
});

test("no read, or no room for one beside the pane's inset, is no rows", () => {
  expect(chartReadLines(null, 80)).toEqual([]);
  expect(chartReadLines("  ", 80)).toEqual([]);
  expect(chartReadLines(READ, 2)).toEqual([]);
});
