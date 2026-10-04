import { expect, test } from "bun:test";
import { buildMatrixPairHistory, clampMatrixCursor, matrixChartRows, matrixPairRead, matrixSelection, moveMatrixCursor } from "./selection";
import { buildCorrelationSeries } from "./model";
import { CORRELATION_RANGE_OPTIONS } from "../settings";

test("cell keys clamp at edges, reach the symbol column, and survive a shorter ticker list", () => {
  for (const [forward, back, axis] of [["j", "k", "row"], ["down", "up", "row"], ["l", "h", "column"], ["right", "left", "column"]] as const) {
    const start = { row: 0, column: 0 };
    expect(moveMatrixCursor(start, forward, 4)[axis]).toBe(1);
    expect(moveMatrixCursor(start, back, 4)[axis]).toBe(axis === "row" ? 0 : -1);
    expect(moveMatrixCursor({ row: 3, column: 3 }, forward, 4)[axis]).toBe(3);
  }
  expect(moveMatrixCursor({ row: 2, column: -1 }, "j", 4)).toEqual({ row: 3, column: -1 });
  expect(moveMatrixCursor({ row: 2, column: -1 }, "h", 4)).toEqual({ row: 2, column: -1 });
  expect(moveMatrixCursor({ row: 2, column: -1 }, "l", 4)).toEqual({ row: 2, column: 0 });
  expect(clampMatrixCursor({ row: 9, column: 8 }, 2)).toEqual({ row: 1, column: 1 });
  expect(matrixSelection([], { row: 9, column: 8 })).toBeNull();
  expect(matrixSelection(["AAPL", "MSFT"], { row: 9, column: 8 })).toEqual(["MSFT", "MSFT"]);
  expect(matrixSelection(["AAPL", "MSFT"], { row: 1, column: -1 })).toEqual(["MSFT", "MSFT"]);
  expect(matrixSelection(["AAPL", "MSFT"], { row: 1, column: 0 })).toEqual(["MSFT", "AAPL"]);
});

test("the chart gives way before four matrix rows, including horizontal scroll chrome and its read line", () => {
  expect(matrixChartRows(80, 12, 4, 68)).toBe(0);
  expect(matrixChartRows(80, 13, 4, 68)).toBe(6);
  expect(matrixChartRows(80, 13, 10, 78)).toBe(6);
  expect(matrixChartRows(70, 13, 10, 78)).toBe(0);
  expect(matrixChartRows(80, 24, 10, 78)).toBe(11);
  expect(matrixChartRows(23, 40, 10, 78)).toBe(0);
  for (let height = 1; height <= 40; height++) {
    const chart = matrixChartRows(80, height, 10, 78);
    if (chart) expect(height - 1 - chart - 1 - 1).toBeGreaterThanOrEqual(4);
  }
});

const history = (count: number, flatAfter = Infinity) => buildCorrelationSeries("AAPL", Array.from({ length: count }, (_, index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)),
  close: index >= flatAfter ? 100 : 100 + index + Math.sin(index) * 5,
})));

test("the chosen range uses full 20/60-return windows without borrowing older data", () => {
  const data = history(70);
  for (const range of CORRELATION_RANGE_OPTIONS) {
    const result = buildMatrixPairHistory(data, data, range);
    const window = range === "1M" ? 20 : 60;
    expect(result.window).toBe(window);
    expect(result.points.slice(0, window).every((point) => point.value === null)).toBe(true);
    expect(result.points[window]?.value).toBeCloseTo(1);
    expect(result.latest).toBeCloseTo(1);
  }
  expect(buildMatrixPairHistory(history(20), history(20), "1M").latest).toBeNull();
  expect(buildMatrixPairHistory(history(21), history(21), "1M").latest).toBeCloseTo(1);
  expect(buildMatrixPairHistory(history(60), history(60), "1Y").latest).toBeNull();
});

test("a missing latest window stays a gap and the read never passes off an older correlation as now", () => {
  const data = history(130, 65);
  const result = buildMatrixPairHistory(data, data, "1Y");
  expect(result.min).toBeCloseTo(1);
  expect(result.max).toBeCloseTo(1);
  expect(result.latest).toBeNull();
  expect(result.points.at(-1)?.value).toBeNull();
  expect(matrixPairRead(["NVDA", "AMD"], 0.501, { window: 60, latest: 0.634, min: 0.213, max: 0.72 }))
    .toBe("NVDA and AMD: full period 0.50, now 0.63 (60 day), range 0.21 to 0.72");
  expect(matrixPairRead(["AAPL", "MSFT"], null, result))
    .toBe("AAPL and MSFT: full period —, now — (60 day), range 1.00 to 1.00");
});
