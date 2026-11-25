import type { DemergerAction, SplitAction } from "../types/financials";
import { splitShareTerms } from "../market-data/split-terms";
import { demergerSuccessor, priceAdjustment, priceAdjustments, type PriceAdjustment } from "../market-data/price-adjustments";

/** The flag a bar takes when a business was demerged out of the listing at it. */
export const DEMERGER_FLAG = "demerger";
/** The flag the bar a split took effect in takes: the first in post-split shares. */
export const SPLIT_FLAG = "split";
/** The flag the bar a spin-off's price adjustment took effect in takes, where the bars before it are adjusted for it. */
export const SPIN_OFF_FLAG = "spin-off";
/** The flag the bar an adjustment factor no action on record explains took effect in takes. */
export const ADJUSTMENT_FLAG = "adjustment";

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
 * period, the last one too. A factor no share count states, or one a
 * demerger's ex-date explains, is a price adjustment (withPriceAdjustmentFlags).
 */
export function withSplitFlags<Row extends DemergerRow>(rows: readonly Row[], splits: readonly SplitAction[], demergers: readonly DemergerAction[] = []): {
  rows: Row[];
  splits: Array<{ split: SplitAction; barBefore: boolean }>;
} {
  const marked = [...rows];
  const flagged: Array<{ split: SplitAction; barBefore: boolean }> = [];
  for (const split of [...splits].sort((left, right) => left.date.localeCompare(right.date))) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(split.date) || !splitShareTerms(split) || priceAdjustment(split, demergers)) continue;
    const index = actionBarIndex(marked, split.date.slice(0, 10), false);
    if (index < 0) continue;
    const row = marked[index]!;
    const codes = (row.flag ?? "").split(",").filter(Boolean);
    if (!codes.includes(SPLIT_FLAG)) marked[index] = { ...row, flag: [...codes, SPLIT_FLAG].join(",") };
    flagged.push({ split, barBefore: index > 0 });
  }
  return { rows: marked, splits: flagged };
}

/**
 * A price adjustment the bars in a history come before. `at` is the bar
 * flagged for it, where the closes across it run on without its fall: the
 * bars before it are adjusted for it. Null where no close shows their basis,
 * `unshown` saying why: the bars end before it (`after`), a close either side
 * of it is missing (`missing`), or the move across it is near neither none nor
 * the factor's fall (`between`).
 */
export interface BarsAdjustment {
  adjustment: PriceAdjustment;
  at: string | null;
  unshown?: "after" | "missing" | "between";
}

/**
 * How near the move across an adjustment must come to a fall by its factor,
 * or to none, to witness either: a third of the factor's own step, so the two
 * never overlap and a move between them witnesses neither.
 */
const WITNESS_SHARE = 1 / 3;

/**
 * What the closes across `index` witness of the factor: a fall by it (`fall`,
 * bars that traded through the adjustment unadjusted), a run on without it
 * (`continuity`, bars adjusted for it), or nothing: the bar there or the one
 * before has no close (`missing`), or the move is near neither (`between`).
 */
function factorEvidence(rows: readonly DemergerRow[], index: number, factor: number): "fall" | "continuity" | "missing" | "between" {
  const before = rows[index - 1]?.close;
  const at = rows[index]?.close;
  if (before == null || !(before > 0) || at == null || !(at > 0)) return "missing";
  const move = Math.log(at / before);
  const step = Math.log(factor);
  const near = Math.abs(step) * WITNESS_SHARE;
  if (Math.abs(move + step) <= near) return "fall";
  return Math.abs(move) <= near ? "continuity" : "between";
}

/**
 * The rows with the bar each price adjustment took effect in flagged, every
 * adjustment the bars come before, oldest first, and the demergers whose bars
 * fell by the factor. A spin-off's (CTVA's 6665:1000 of 2026-10-01, VYLR's)
 * is flagged `spin-off`, any other factor `adjustment`, where the closes
 * across it run on. Bars that fall by the factor across it traded through it
 * unadjusted: a spin-off's demerger is then `traded`, flagged `demerger`
 * however small the fall (withDemergerFlags). Closes that show neither, and
 * bars that end before it, are flagged for nothing.
 */
export function withPriceAdjustmentFlags<Row extends DemergerRow>(
  rows: readonly Row[],
  splits: readonly SplitAction[],
  demergers: readonly DemergerAction[],
): { rows: Row[]; adjustments: BarsAdjustment[]; traded: DemergerAction[] } {
  const marked = [...rows];
  const adjustments: BarsAdjustment[] = [];
  const traded: DemergerAction[] = [];
  const first = rows[0]?.date.slice(0, 10);
  if (!first) return { rows: marked, adjustments, traded };
  for (const adjustment of priceAdjustments(splits, demergers)) {
    if (adjustment.date <= first) continue;
    const index = actionBarIndex(marked, adjustment.date, true);
    if (index < 0) {
      if (adjustment.date > rows.at(-1)!.date.slice(0, 10)) adjustments.push({ adjustment, at: null, unshown: "after" });
      continue;
    }
    const evidence = factorEvidence(marked, index, adjustment.factor);
    if (evidence === "fall") {
      if (adjustment.demerger) traded.push(adjustment.demerger);
      continue;
    }
    if (evidence !== "continuity") {
      adjustments.push({ adjustment, at: null, unshown: evidence });
      continue;
    }
    const flag = adjustment.demerger ? SPIN_OFF_FLAG : ADJUSTMENT_FLAG;
    const row = marked[index]!;
    const codes = (row.flag ?? "").split(",").filter(Boolean);
    if (!codes.includes(flag)) marked[index] = { ...row, flag: [...codes, flag].join(",") };
    adjustments.push({ adjustment, at: row.date });
  }
  return { rows: marked, adjustments, traded };
}

/**
 * What the bars before each price adjustment are: "On 2026-10-01 the seed
 * business was spun off into VYLR:NYSE (Vylor Inc.), 1 share per share:
 * CTVA's bars before it are adjusted for it (6665:1000), so they are not the
 * prices that traded then (flag spin-off)", where the bar it took effect in
 * runs on without the factor's fall. Bars that all end before it show no such
 * bar, and their date says nothing of their basis: they may be adjusted for
 * it. Nor do closes across it that are missing or move by neither none nor the
 * factor. A factor no action on record explains says only that the bars before
 * it may be adjusted by it. Null without one.
 */
export function historyAdjustmentNote(symbol: string, adjustments: readonly BarsAdjustment[]): string | null {
  if (adjustments.length === 0) return null;
  const parts = adjustments.map(({ adjustment, at, unshown }) => {
    const { demerger, terms, date } = adjustment;
    const untold = unshown === "after" ? "no bar here spans it to tell"
      : unshown === "missing" ? "a close either side of it is missing, so the bars do not tell"
        : "the move across it is near neither none nor the factor's fall, so the bars do not tell";
    if (demerger) {
      const what = demerger.business ? `the ${demerger.business} business was spun off` : "a business was spun off";
      const ratio = demerger.ratio ? `, ${demerger.ratio} share per share` : "";
      if (at != null) {
        return `On ${date} ${what} into ${demergerSuccessor(demerger)}${ratio}: ${symbol}'s bars before it are adjusted for it (${terms}), so they are not the prices that traded then (flag ${SPIN_OFF_FLAG})`;
      }
      return unshown === "after"
        ? `${symbol}'s bars here end before the ${demergerSuccessor(demerger)} spin-off of ${date} and may be adjusted for it (${terms}), `
          + `so they may not be the prices that traded then: ${untold}`
        : `On ${date} ${what} into ${demergerSuccessor(demerger)}${ratio}: ${symbol}'s bars before it may be adjusted for it (${terms}), `
          + `so they may not be the prices that traded then: ${untold}`;
    }
    if (at != null) {
      return `On ${date} ${symbol} has a ${terms} adjustment factor in no share terms, which no action on record explains: bars before it may be adjusted by it (flag ${ADJUSTMENT_FLAG})`;
    }
    return unshown === "after"
      ? `${symbol}'s bars here end before a ${terms} adjustment factor of ${date} in no share terms, which no action on record explains, `
        + `and may be adjusted by it: ${untold}`
      : `On ${date} ${symbol} has a ${terms} adjustment factor in no share terms, which no action on record explains: bars before it may be adjusted by it, `
        + `and ${untold}`;
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
