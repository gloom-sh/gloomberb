import { expect, test } from "bun:test";
import { CHART_READ_MAX_ROWS, terminalChartReadLines } from "./read";

const READ = "Education and communication moved the 0.6% rise by less than 0.01 points and is 5.0% of the basket.";

test("a read that fits the pane stays on one row, whole", () => {
  expect(terminalChartReadLines(READ, READ.length + 2)).toEqual([READ]);
});

test("a longer read wraps at words, every word kept in order", () => {
  const lines = terminalChartReadLines(READ, 62);
  expect(lines).toEqual(["Education and communication moved the 0.6% rise by less than", "0.01 points and is 5.0% of the basket."]);
  expect(lines.every((line) => line.length <= 60)).toBe(true);
});

test("past the row cap the last row ends in an ellipsis instead of dropping words silently", () => {
  const lines = terminalChartReadLines(READ, 30);
  expect(lines).toHaveLength(CHART_READ_MAX_ROWS);
  expect(lines).toEqual(["Education and communication", "moved the 0.6% rise by less", "than 0.01 points and is 5.0…"]);
  // Three rows hold the whole sentence at a width a little wider; nothing is cut then.
  expect(terminalChartReadLines(READ, 50).join(" ")).toBe(READ);
});

test("no read, or no room for one beside the pane's inset, is no rows", () => {
  expect(terminalChartReadLines(null, 80)).toEqual([]);
  expect(terminalChartReadLines("  ", 80)).toEqual([]);
  expect(terminalChartReadLines(READ, 2)).toEqual([]);
});
