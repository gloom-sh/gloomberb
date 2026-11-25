import type { CorporateActionsData, DemergerAction, DividendAction, EarningsAction, SplitAction } from "../types/financials";
import { splitShareTerms } from "./split-terms";

/**
 * A factor in a listing's split history that is no share split. One dated a
 * demerger's ex-date on record is that spin-off's price adjustment (CTVA's
 * 6665:1000 of 2026-10-01, the day its seed business left as VYLR); any other
 * that states no share count (GE's 1253:1000 of 2024-04-02, with no demerger
 * on record) is an adjustment factor, and says no more than that. The figures
 * before it are labelled as adjusted, never multiplied back: what was paid or
 * traded before the adjustment is not known from them.
 */
export interface PriceAdjustment {
  date: string;
  /** What the factor moves a price by: 6.665 for 6665:1000. */
  factor: number;
  /** The factor as it is written: `6665:1000`. */
  terms: string;
  /** The demerger on record the factor is the adjustment for. */
  demerger?: DemergerAction;
}

type Factor = Pick<SplitAction, "date" | "fromFactor" | "toFactor" | "ratio">;

/**
 * The split as a price adjustment: a factor no share count states. One that
 * lowers the price on a demerger's ex-date is that demerger's; any other is an
 * adjustment, no more. Null for a split in share terms, on a demerger's
 * ex-date too (a 2-for-1 beside CTVA's 6665:1000 stays a split), and for a
 * factor that moves nothing.
 */
export function priceAdjustment(split: Factor, demergers: readonly DemergerAction[] = []): PriceAdjustment | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(split.date) || splitShareTerms(split)) return null;
  const { fromFactor: from, toFactor: to } = split;
  const factor = from != null && to != null && from > 0 && to > 0 ? to / from : split.ratio;
  if (factor == null || !Number.isFinite(factor) || !(factor > 0) || factor === 1) return null;
  const date = split.date.slice(0, 10);
  const demerger = factor > 1 ? demergers.find((action) => action.exDate === date) : undefined;
  const terms = from != null && to != null && from > 0 && to > 0 ? `${to}:${from}` : String(Number(factor.toFixed(6)));
  return { date, factor, terms, ...(demerger ? { demerger } : {}) };
}

/** A listing's price adjustments, oldest first. */
export function priceAdjustments(
  splits: readonly Factor[] | undefined,
  demergers: readonly DemergerAction[] | undefined,
): PriceAdjustment[] {
  return (splits ?? []).flatMap((split) => priceAdjustment(split, demergers ?? []) ?? [])
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** The adjustments a figure dated `date` comes before, oldest first. */
export function adjustmentsAfter(adjustments: readonly PriceAdjustment[], date: string): PriceAdjustment[] {
  const day = date.slice(0, 10);
  return adjustments.filter((adjustment) => adjustment.date > day);
}

/** The company a demerged business went to, as `--json` and the notes name it: "TMCV:NSE (Tata Motors Limited)". */
export function demergerSuccessor(demerger: Pick<DemergerAction, "successor">): string {
  const { symbol, exchange, name } = demerger.successor;
  const key = exchange ? `${symbol}:${exchange}` : symbol;
  return name ? `${key} (${name})` : key;
}

/**
 * What the figures before these adjustments are adjusted for: "adjusted for
 * the VYLR spin-off of 2026-10-01 (6665:1000)", "adjusted by the 1253:1000
 * factor of 2024-04-02". `dated: false` for a narrow cell: "adjusted for the
 * VYLR spin-off". Empty with none.
 */
export function adjustedForText(adjustments: readonly PriceAdjustment[], dated = true): string {
  if (adjustments.length === 0) return "";
  const named = adjustments.map((adjustment) => {
    if (adjustment.demerger) {
      const spinOff = `for the ${adjustment.demerger.successor.symbol} spin-off`;
      return dated ? `${spinOff} of ${adjustment.date} (${adjustment.terms})` : spinOff;
    }
    return dated ? `by the ${adjustment.terms} factor of ${adjustment.date}` : `by the ${adjustment.terms} factor`;
  });
  return `adjusted ${named.join(" and ")}`;
}

/**
 * Whether a paid row is as its publisher or the issuer's own forms state it:
 * its date before an adjustment says nothing of its basis, so it is shown as
 * published, with no adjustment named.
 */
export function publishedDividend(dividend: Pick<DividendAction, "source" | "parts">): boolean {
  return !!dividend.source || !!dividend.parts?.length;
}

/** Whether a report's EPS is the company's own release's (`press-release`), shown as reported, with no adjustment named. */
export function publishedEps(earning: Pick<EarningsAction, "epsActualSource">): boolean {
  return earning.epsActualSource === "press-release";
}

/**
 * The corporate actions as `--json` states them: each factor that is no
 * split says what it is (`kind`, the spin-off's successor beside it). The
 * amounts stay as the history states them.
 */
export function withPriceAdjustmentKinds<Data extends CorporateActionsData>(data: Data): Data {
  const adjustments = priceAdjustments(data.splits, data.demergers);
  if (adjustments.length === 0) return data;
  return {
    ...data,
    splits: data.splits.map((split) => {
      const adjustment = priceAdjustment(split, data.demergers ?? []);
      if (!adjustment) return split;
      return adjustment.demerger
        ? { ...split, kind: "spin-off adjustment", spinOff: adjustment.demerger.successor.symbol }
        : { ...split, kind: "adjustment factor" };
    }),
  };
}
