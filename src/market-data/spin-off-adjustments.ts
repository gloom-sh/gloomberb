import type { CorporateActionsData, DividendAction, SplitAction } from "../types/financials";
import { splitShareTerms } from "./split-terms";

/**
 * A split-feed factor no share count states (CTVA's 6665:1000 on 2026-10-01,
 * GE's 1253:1000 on 2024-04-02): a spin-off's price adjustment. The feed
 * divides the prices, dividends and EPS dated before it by `factor`, as it
 * divides a split's, though the spin-off added no share.
 */
export interface SpinOffAdjustment {
  date: string;
  factor: number;
}

/** The split as a spin-off's price adjustment: whole-number terms no share count states, that lower the price. Null for a split. */
export function spinOffAdjustment(split: Pick<SplitAction, "date" | "fromFactor" | "toFactor">): SpinOffAdjustment | null {
  const { fromFactor: from, toFactor: to } = split;
  if (!Number.isInteger(from) || !Number.isInteger(to) || !(from! > 0) || !(to! > from!)) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(split.date) || splitShareTerms(split)) return null;
  return { date: split.date.slice(0, 10), factor: to! / from! };
}

/** A listing's spin-off adjustments, oldest first. */
export function spinOffAdjustments(splits: readonly Pick<SplitAction, "date" | "fromFactor" | "toFactor">[] | undefined): SpinOffAdjustment[] {
  return (splits ?? []).flatMap((split) => spinOffAdjustment(split) ?? []).sort((left, right) => left.date.localeCompare(right.date));
}

/** What the feed divided a figure dated `date` by for the spin-offs after it; 1 with none. */
export function spinOffDivisor(adjustments: readonly SpinOffAdjustment[], date: string): number {
  const day = date.slice(0, 10);
  return adjustments.reduce((product, adjustment) => (adjustment.date > day ? product * adjustment.factor : product), 1);
}

/** A divisor as it is said: `÷6.665`, `÷1.6051`. */
export function spinOffDivisorText(divisor: number): string {
  return `÷${Number(divisor.toFixed(4))}`;
}

/** The history's amounts carry this many decimals. */
const HISTORY_DECIMALS = 6;

/**
 * A spin-off-adjusted amount multiplied back: to the cent's hundredth when the
 * adjusted figure's own rounding allows it ($0.027007 × 6.665 is $0.18), to
 * the history's decimals otherwise.
 */
function undone(amount: number, divisor: number): number {
  const paid = amount * divisor;
  const tolerance = 0.5 * 10 ** -HISTORY_DECIMALS * divisor + 1e-12;
  const short = Math.round(paid * 1e4) / 1e4;
  return Math.abs(paid - short) <= tolerance ? short : Number(paid.toFixed(HISTORY_DECIMALS));
}

/** A paid dividend as it was paid, and the history's amount beside it where a spin-off adjustment changed it. */
export interface PaidDividend {
  amount: number;
  /** The history's amount, divided by `divisor` for the spin-offs after the ex-date. */
  adjusted?: number;
  divisor?: number;
}

/**
 * A paid dividend as it was paid, per share: the history divides an amount
 * before a spin-off adjustment by it, as it divides one before a split
 * (CTVA's $0.18 of 2026-09-01 reads $0.027007 after its 6.665 of
 * 2026-10-01), though the spin-off added no share. A row its publisher or
 * the issuer's own forms state is as published, and stays.
 */
export function paidDividend(dividend: DividendAction, adjustments: readonly SpinOffAdjustment[]): PaidDividend {
  if (dividend.source || dividend.parts?.length || !Number.isFinite(dividend.amount)) return { amount: dividend.amount };
  const divisor = spinOffDivisor(adjustments, dividend.exDate);
  if (divisor === 1) return { amount: dividend.amount };
  return { amount: undone(dividend.amount, divisor), adjusted: dividend.amount, divisor };
}

/**
 * The corporate actions as `--json` states them: each spin-off adjustment
 * named (`kind`), each dividend it changed with what was paid
 * (`paidAmount`) and the divisor, and each report whose EPS it divides with
 * the divisor. Unchanged without one.
 */
export function withSpinOffAdjustments<Data extends CorporateActionsData>(data: Data): Data {
  const adjustments = spinOffAdjustments(data.splits);
  if (adjustments.length === 0) return data;
  return {
    ...data,
    dividends: data.dividends.map((dividend) => {
      const paid = paidDividend(dividend, adjustments);
      return paid.adjusted == null ? dividend : { ...dividend, paidAmount: paid.amount, spinOffDivisor: paid.divisor };
    }),
    splits: data.splits.map((split) => (spinOffAdjustment(split) ? { ...split, kind: "spin-off adjustment" } : split)),
    earnings: data.earnings.map((event) => {
      const divisor = spinOffDivisor(adjustments, event.date);
      return divisor === 1 || (event.epsActual == null && event.epsEstimate == null) ? event : { ...event, spinOffDivisor: divisor };
    }),
  };
}

/** The paid history with every amount as it was paid (paidDividend). */
export function asPaidDividends(dividends: readonly DividendAction[], splits: readonly SplitAction[] | undefined): DividendAction[] {
  const adjustments = spinOffAdjustments(splits);
  if (adjustments.length === 0) return [...dividends];
  return dividends.map((dividend) => {
    const paid = paidDividend(dividend, adjustments);
    return paid.adjusted == null ? dividend : { ...dividend, amount: paid.amount };
  });
}
