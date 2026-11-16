import type { DemergerAction } from "../types/financials";

/** The flag a bar takes when a business was demerged out of the listing at it. */
export const DEMERGER_FLAG = "demerger";

/**
 * A close this far below the one before can be a business leaving the line
 * rather than the market: only then are the listing's corporate actions read
 * beside its bars.
 */
const BREAK_FALL = 0.2;

interface DemergerRow {
  date: string;
  close?: number | null;
  flag?: string | null;
  interval?: string | null;
}

/** Whether any bar closes at least `BREAK_FALL` below the bar before it. */
export function hasPriceBreak(rows: readonly Pick<DemergerRow, "close">[]): boolean {
  let previous: number | null = null;
  for (const row of rows) {
    if (row.close == null || !(row.close > 0)) continue;
    if (previous != null && row.close <= previous * (1 - BREAK_FALL)) return true;
    previous = row.close;
  }
  return false;
}

/** The demerger of `--json` and the note: "TMCV:NSE (Tata Motors Limited)". */
export function demergerSuccessor(action: Pick<DemergerAction, "successor">): string {
  const { symbol, exchange, name } = action.successor;
  const key = exchange ? `${symbol}:${exchange}` : symbol;
  return name ? `${key} (${name})` : key;
}

/**
 * The bar a demerger's ex-date falls in: the daily bar of that session (the
 * next one when the source has none of it), or the week's or month's bar
 * that holds it. -1 when the bars do not reach it.
 */
function demergerBarIndex(rows: readonly DemergerRow[], exDate: string): number {
  const day = (row: DemergerRow) => row.date.slice(0, 10);
  const interval = rows[0]?.interval;
  if (interval === "1wk" || interval === "1mo") {
    const holding = rows.findLastIndex((row) => day(row) <= exDate);
    if (holding <= 0) return -1;
    // The last bar holds the ex-date only when its week or month runs over it.
    const start = day(rows[holding]!);
    const within = interval === "1mo" ? start.slice(0, 7) === exDate.slice(0, 7)
      : Date.parse(`${exDate}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) < 7 * 86_400_000;
    return holding < rows.length - 1 || within ? holding : -1;
  }
  const first = rows.findIndex((row) => day(row) >= exDate);
  // A bar before the ex-date is needed for the fall to be in the rows at all.
  return first > 0 ? first : -1;
}

/**
 * The rows with the bar each demerger in them falls in flagged `demerger`,
 * and the dates of those bars, oldest first: closes before them include a
 * business the listing no longer has.
 */
export function withDemergerFlags<Row extends DemergerRow>(rows: readonly Row[], demergers: readonly DemergerAction[]): { rows: Row[]; breaks: Array<{ date: string; action: DemergerAction }> } {
  const marked = [...rows];
  const breaks: Array<{ date: string; action: DemergerAction }> = [];
  for (const action of [...demergers].sort((left, right) => left.exDate.localeCompare(right.exDate))) {
    const index = demergerBarIndex(marked, action.exDate);
    if (index < 0) continue;
    const row = marked[index]!;
    const codes = (row.flag ?? "").split(",").filter(Boolean);
    if (!codes.includes(DEMERGER_FLAG)) marked[index] = { ...row, flag: [...codes, DEMERGER_FLAG].join(",") };
    breaks.push({ date: row.date, action });
  }
  return { rows: marked, breaks };
}

/**
 * "On 2025-10-14 the commercial vehicles business was demerged into TMCV:NSE
 * (Tata Motors Limited), 1 share per share, listed 2025-11-12: closes before
 * it include that business, so the fall from 660.75 to 395.45 is no market
 * loss (flag demerger)". Null without one in the bars.
 */
export function historyDemergerNote(
  rows: readonly DemergerRow[],
  breaks: ReadonlyArray<{ date: string; action: DemergerAction }>,
  price: (value: number) => string,
): string | null {
  if (breaks.length === 0) return null;
  const parts = breaks.map(({ date, action }) => {
    const index = rows.findIndex((row) => row.date === date);
    const before = rows.slice(0, index).findLast((row) => row.close != null && row.close > 0)?.close;
    const at = rows[index]?.close;
    const what = action.business ? `the ${action.business} business was demerged` : "a business was demerged";
    const ratio = action.ratio ? `, ${action.ratio} share per share` : "";
    const listed = action.successor.listedOn ? `, listed ${action.successor.listedOn}` : ", not yet listed";
    const fall = before != null && at != null ? `, so the fall from ${price(before)} to ${price(at)} is no market loss` : "";
    return `On ${action.exDate} ${what} into ${demergerSuccessor(action)}${ratio}${listed}: closes before it include that business${fall}`;
  });
  return `${parts.join("; ")} (flag ${DEMERGER_FLAG})`;
}

/**
 * The rows split at each demerger: a drawdown is measured within one, never
 * from a close that held the business to one that did not.
 */
export function demergerRuns<Row extends { date: string }>(rows: readonly Row[], breaks: ReadonlyArray<{ date: string }>): Row[][] {
  if (breaks.length === 0) return [[...rows]];
  const runs: Row[][] = [[]];
  const starts = new Set(breaks.map((entry) => entry.date.slice(0, 10)));
  for (const row of rows) {
    if (starts.has(row.date.slice(0, 10)) && runs.at(-1)!.length > 0) runs.push([]);
    runs.at(-1)!.push(row);
  }
  return runs;
}
