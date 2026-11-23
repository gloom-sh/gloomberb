import { MISSING_VALUE } from "../../../../utils/format";
import { chartTableLayout } from "../../../../components/chart-table/layout";
import { alignDailyCloses, pairedChanges } from "../compute";
import { buildRollingCorrelationPoints } from "../relationship/model";
import type { CorrelationRangePreset } from "../settings";
import type { CorrelationSeries } from "./model";

/** Column -1 is the existing symbol-row cursor, reachable from the first cell. */
export interface MatrixCursor { row: number; column: number }

export function clampMatrixCursor(cursor: MatrixCursor, count: number): MatrixCursor {
  const last = Math.max(0, count - 1);
  return {
    row: Math.max(0, Math.min(last, cursor.row)),
    column: Math.max(-1, Math.min(last, cursor.column)),
  };
}

export function moveMatrixCursor(cursor: MatrixCursor, key: string, count: number): MatrixCursor {
  const next = clampMatrixCursor(cursor, count);
  if (key === "j" || key === "down") next.row++;
  if (key === "k" || key === "up") next.row--;
  if (key === "h" || key === "left") next.column--;
  if (key === "l" || key === "right") next.column++;
  return clampMatrixCursor(next, count);
}

export function matrixSelection(symbols: readonly string[], cursor: MatrixCursor): [string, string] | null {
  if (!symbols.length) return null;
  const { row, column } = clampMatrixCursor(cursor, symbols.length);
  return [symbols[row]!, symbols[column < 0 ? row : column]!];
}

/**
 * The pair chart's rows below a matrix of `count` symbols, in a pane `height`
 * tall that also draws the query bar and `noteRows` lines of notes (the
 * return basis, a cell's note). The kit budget includes the read line. No
 * compact strip: the matrix wins.
 */
export function matrixChartRows(width: number, height: number, count: number, matrixWidth: number, noteRows = 0): number {
  const layout = chartTableLayout({
    width, height, queryRows: 1 + noteRows, tableRows: count,
    tableChromeRows: matrixWidth > width - 1 ? 2 : 1,
    chart: { minRows: 7, strip: false },
  });
  return layout.mode === "full" ? layout.chartRows - 1 : 0;
}

/**
 * The matrix's and the pair chart's rows in the pane (matrixChartRows): the
 * chart, with its read line, takes what the matrix's header and rows leave
 * after the query bar and the notes, so a note line never comes out of the
 * matrix's last row.
 */
export function matrixPaneRows(
  width: number, height: number, count: number, matrixWidth: number, noteRows: number, charted: boolean,
): { matrixHeight: number; chartRows: number } {
  const chartRows = charted ? matrixChartRows(width, height, count, matrixWidth, noteRows) : 0;
  return { chartRows, matrixHeight: Math.max(1, height - 1 - noteRows - (chartRows > 0 ? chartRows + 1 : 0)) };
}

export function buildMatrixPairHistory(
  left: CorrelationSeries | undefined,
  right: CorrelationSeries | undefined,
  range: CorrelationRangePreset,
) {
  const window = range === "1M" ? 20 : 60;
  const aligned = alignDailyCloses(left?.prices ?? [], right?.prices ?? []).map((point) => ({
    ...point, date: new Date(`${point.dateKey}T00:00:00Z`),
  }));
  const returns = pairedChanges(aligned, left?.basis, right?.basis).map(({ dateKey, left: leftReturn, right: rightReturn }) => ({
    dateKey, date: new Date(`${dateKey}T00:00:00Z`), leftReturn, rightReturn,
  }));
  const points = buildRollingCorrelationPoints(returns, window);
  const byTime = new Map(points.map((point) => [point.date.getTime(), point.close]));
  const values = points.map((point) => point.close);
  const latest = byTime.get(returns.at(-1)?.date.getTime() ?? NaN) ?? null;
  return {
    window,
    // Explicit gaps retain the warm-up period and zero-variance windows.
    points: aligned.map(({ date }) => ({ date, value: byTime.get(date.getTime()) ?? null })),
    latest,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    unavailable: returns.length < window
      ? `Rolling correlation needs ${window} shared returns; ${returns.length} available.`
      : latest === null ? `Rolling correlation unavailable: zero return variance in the latest ${window} shared returns.` : null,
  };
}

export function matrixPairRead(
  pair: readonly [string, string],
  fullPeriod: number | null,
  history: Pick<ReturnType<typeof buildMatrixPairHistory>, "window" | "latest" | "min" | "max">,
): string {
  const value = (number: number | null) => number !== null && Number.isFinite(number) ? number.toFixed(2) : MISSING_VALUE;
  return `${pair[0]} and ${pair[1]}: full period ${value(fullPeriod)}, now ${value(history.latest)} (${history.window} day), range ${value(history.min)} to ${value(history.max)}`;
}
