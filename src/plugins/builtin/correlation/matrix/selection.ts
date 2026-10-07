import { chartTableLayout } from "../../../../components/chart-table/layout";
import { alignDailyCloses } from "../compute";
import { buildRelationshipReturns, buildRollingCorrelationPoints } from "../relationship/model";
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

/** The kit budget includes the read line. No compact strip: the matrix wins. */
export function matrixChartRows(width: number, height: number, count: number, matrixWidth: number): number {
  const layout = chartTableLayout({
    width, height, queryRows: 1, tableRows: count,
    tableChromeRows: matrixWidth > width - 1 ? 2 : 1,
    chart: { minRows: 7, strip: false },
  });
  return layout.mode === "full" ? layout.chartRows - 1 : 0;
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
  const returns = buildRelationshipReturns(aligned);
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
  const value = (number: number | null) => number !== null && Number.isFinite(number) ? number.toFixed(2) : "—";
  return `${pair[0]} and ${pair[1]}: full period ${value(fullPeriod)}, now ${value(history.latest)} (${history.window} day), range ${value(history.min)} to ${value(history.max)}`;
}
