import type { DemergerAction, SplitAction } from "../types/financials";
import { splitShareTerms } from "../market-data/split-terms";
import { spinOffAdjustments, spinOffDivisor, spinOffDivisorText, type SpinOffAdjustment } from "../market-data/spin-off-adjustments";

/** The flag a bar takes when a business was demerged out of the listing at it. */
export const DEMERGER_FLAG = "demerger";
/** The flag the bar a split took effect in takes: the first in post-split shares. */
export const SPLIT_FLAG = "split";
/** The flag the bar a spin-off's price adjustment took effect in takes: the first the source did not divide by it. */
export const SPIN_OFF_FLAG = "spin-off";

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
 * The bar a corporate action's ex-date falls in: the daily bar of that
 * session (the next one when the source has none of it), or the week's or
 * month's bar that holds it. -1 when the bars do not reach it, or, with
 * `barBefore`, when no bar comes before it (a demerger's fall needs one).
 */
function actionBarIndex(rows: readonly DemergerRow[], exDate: string, barBefore: boolean): number {
  const day = (row: DemergerRow) => row.date.slice(0, 10);
  const interval = rows[0]?.interval;
  const first = barBefore ? 1 : 0;
  if (interval === "1wk" || interval === "1mo") {
    const holding = rows.findLastIndex((row) => day(row) <= exDate);
    if (holding < first) return -1;
    // The last bar holds the ex-date only when its week or month runs over it.
    const start = day(rows[holding]!);
    const within = interval === "1mo" ? start.slice(0, 7) === exDate.slice(0, 7)
      : Date.parse(`${exDate}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) < 7 * 86_400_000;
    return holding < rows.length - 1 || within ? holding : -1;
  }
  const index = rows.findIndex((row) => day(row) >= exDate);
  // An ex-date before the first daily bar is not in the rows, however near.
  return index >= first && (index > 0 || day(rows[0]!) === exDate) ? index : -1;
}

/**
 * The rows with the bar each split took effect in flagged `split` (FFAI's
 * 1-for-150 reverse on 2026-07-24), as `history` marks it beside the note
 * naming it, and those splits, oldest first, each with whether a bar comes
 * before its own: a weekly or monthly bar holds the split anywhere in its
 * period, the last one too. A factor no share count states is left to the
 * demerger flag.
 */
export function withSplitFlags<Row extends DemergerRow>(rows: readonly Row[], splits: readonly SplitAction[]): {
  rows: Row[];
  splits: Array<{ split: SplitAction; barBefore: boolean }>;
} {
  const marked = [...rows];
  const flagged: Array<{ split: SplitAction; barBefore: boolean }> = [];
  for (const split of [...splits].sort((left, right) => left.date.localeCompare(right.date))) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(split.date) || !splitShareTerms(split)) continue;
    const index = actionBarIndex(marked, split.date.slice(0, 10), false);
    if (index < 0) continue;
    const row = marked[index]!;
    const codes = (row.flag ?? "").split(",").filter(Boolean);
    if (!codes.includes(SPLIT_FLAG)) marked[index] = { ...row, flag: [...codes, SPLIT_FLAG].join(",") };
    flagged.push({ split, barBefore: index > 0 });
  }
  return { rows: marked, splits: flagged };
}

/** A spin-off adjustment that divides bars in a history: at the bar flagged for it, or after the last (`at` null). */
export interface BarsSpinOff {
  adjustment: SpinOffAdjustment;
  at: string | null;
}

/**
 * The rows with the bar each spin-off's price adjustment took effect in
 * flagged `spin-off` (CTVA's 6.665 on 2026-10-01), and every adjustment that
 * divides any of them, oldest first: the source divides the prices before it
 * (and multiplies the volume), so one after the last bar divides them all.
 */
export function withSpinOffFlags<Row extends DemergerRow>(rows: readonly Row[], splits: readonly SplitAction[]): {
  rows: Row[];
  spinOffs: BarsSpinOff[];
} {
  const marked = [...rows];
  const spinOffs: BarsSpinOff[] = [];
  const first = rows[0]?.date.slice(0, 10);
  if (!first) return { rows: marked, spinOffs };
  for (const adjustment of spinOffAdjustments(splits)) {
    if (adjustment.date <= first) continue;
    const index = actionBarIndex(marked, adjustment.date, true);
    if (index < 0) {
      // Past the last bar: every bar shown is divided by it.
      if (adjustment.date > rows.at(-1)!.date.slice(0, 10)) spinOffs.push({ adjustment, at: null });
      continue;
    }
    const row = marked[index]!;
    const codes = (row.flag ?? "").split(",").filter(Boolean);
    if (!codes.includes(SPIN_OFF_FLAG)) marked[index] = { ...row, flag: [...codes, SPIN_OFF_FLAG].join(",") };
    spinOffs.push({ adjustment, at: row.date });
  }
  return { rows: marked, spinOffs };
}

/** A divided close multiplied back: to the cent where the divided figure's rounding allows (11.65041 × 6.665 is 77.65). */
function undividedPrice(close: number, divisor: number, price: (value: number) => string): string {
  const value = close * divisor;
  const cents = Math.round(value * 100) / 100;
  return Math.abs(value - cents) <= 1e-5 * divisor ? cents.toFixed(2) : price(value);
}

/**
 * "On 2026-10-01 CTVA's bars take a spin-off's price adjustment, not a share
 * split: prices before it are divided by 6.665 and volumes multiplied by it at
 * source, so they are not the prices that traded (the 2026-09-30 close, 11.65041
 * here, is 77.65 before the adjustment) (flag spin-off)". Null without one.
 */
export function historySpinOffNote(
  symbol: string,
  rows: readonly DemergerRow[],
  spinOffs: readonly BarsSpinOff[],
  price: (value: number) => string,
): string | null {
  if (spinOffs.length === 0) return null;
  const adjustments = spinOffs.map(({ adjustment }) => adjustment);
  const parts = spinOffs.map(({ adjustment, at }) => {
    const index = at == null ? rows.length : rows.findIndex((row) => row.date === at);
    const before = rows.slice(0, index).findLast((row) => row.close != null && row.close > 0);
    const divided = spinOffDivisorText(adjustment.factor).slice(1);
    const close = before?.close != null
      ? ` (the ${before.date.slice(0, 10)} close, ${price(before.close)} here, is ${undividedPrice(before.close, spinOffDivisor(adjustments, before.date), price)} before the adjustment)`
      : "";
    return at == null
      ? `${symbol}'s bars here are divided by ${divided} and their volumes multiplied by it at source, for a spin-off's price adjustment on ${adjustment.date} (not a share split), so they are not the prices that traded${close}`
      : `On ${adjustment.date} ${symbol}'s bars take a spin-off's price adjustment, not a share split: prices before it are divided by ${divided} and volumes multiplied by it at source, so they are not the prices that traded${close} (flag ${SPIN_OFF_FLAG})`;
  });
  return `${parts.join("; ")}.`;
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
    const index = actionBarIndex(marked, action.exDate, true);
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
 * The rows split before each bar flagged `demerger`: a drawdown is measured
 * within one run, never from a close that held the business to one that did
 * not. Split by the bar's own flag, not its date: a weekly or monthly close
 * is dated by its last session, not by the date its bar carries.
 */
export function demergerRuns<Row extends { flag?: string | null }>(rows: readonly Row[]): Row[][] {
  const runs: Row[][] = [[]];
  for (const row of rows) {
    if ((row.flag ?? "").split(",").includes(DEMERGER_FLAG) && runs.at(-1)!.length > 0) runs.push([]);
    runs.at(-1)!.push(row);
  }
  return runs;
}
