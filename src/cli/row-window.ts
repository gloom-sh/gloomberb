/**
 * Which rows `--limit` and `--tail` keep, for every command that prints a
 * list. `--limit n` keeps the first n rows as printed. `--tail n` keeps the
 * newest n rows of a dated series, whichever way it runs (the first n of a
 * newest-first series, the last n of an oldest-first one), and the last n of
 * any other list. The kept rows stay in their printed order.
 */
export interface RowWindowOptions {
  limit?: number;
  tail?: number;
}

export interface RowWindow<Row> {
  rows: Row[];
  /** How many rows there were before the cut. */
  total: number;
  /** The end of a dated series the cut kept; null when nothing was cut or the rows are not a dated series. */
  kept: "oldest" | "newest" | null;
  /**
   * Said when `--limit` cut an oldest-first series, which reads as the latest
   * rows but is the earliest: "showing the oldest 2 of 252 rows; --tail 2 for
   * the latest". Null otherwise.
   */
  note: string | null;
}

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function firstTime<Row>(rows: readonly Row[], dateOf: (row: Row) => unknown, fromEnd: boolean): number | null {
  for (let step = 0; step < rows.length; step += 1) {
    const time = timeOf(dateOf(rows[fromEnd ? rows.length - 1 - step : step]!));
    if (time != null) return time;
  }
  return null;
}

/** Which way a dated series runs, from its first and last dated rows; null when it is undated or spans one instant. */
function seriesOrder<Row>(rows: readonly Row[], dateOf: (row: Row) => unknown): "ascending" | "descending" | null {
  const first = firstTime(rows, dateOf, false);
  const last = firstTime(rows, dateOf, true);
  if (first == null || last == null || first === last) return null;
  return first < last ? "ascending" : "descending";
}

/** The rows `options` keep. `dateOf` reads a row's date, which makes the rows a dated series. */
export function windowRows<Row>(
  rows: readonly Row[],
  options: RowWindowOptions,
  dateOf?: (row: Row) => unknown,
): RowWindow<Row> {
  const total = rows.length;
  const count = options.tail ?? options.limit;
  if (count == null || count >= total) return { rows: [...rows], total, kept: null, note: null };
  const order = dateOf ? seriesOrder(rows, dateOf) : null;
  if (options.tail != null) {
    return {
      rows: order === "descending" ? rows.slice(0, count) : rows.slice(total - count),
      total,
      kept: order ? "newest" : null,
      note: null,
    };
  }
  const kept = order === "ascending" ? "oldest" : order === "descending" ? "newest" : null;
  return {
    rows: rows.slice(0, count),
    total,
    kept,
    note: kept === "oldest" ? `showing the oldest ${count} of ${total} rows; --tail ${count} for the latest` : null,
  };
}
