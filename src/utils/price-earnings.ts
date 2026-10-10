import type { Fundamentals } from "../types/financials";
import { formatNumber } from "./format";

export const PRICE_EARNINGS_NOTICE = "N/M = not meaningful. Non-positive P/E values are excluded from ranking.";

/** A multiple over a loss or zero base: there is no number to show, rank or export. */
export const NOT_MEANINGFUL = "not-meaningful";
export type PriceEarnings = number | typeof NOT_MEANINGFUL;

function nonPositive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value <= 0;
}

/**
 * A P/E checked against the earnings it divides by. Zero or negative earnings
 * make it not meaningful whatever multiple a source served beside them: a
 * source P/E priced at an older, profitable period stays positive after the
 * trailing EPS turns into a loss (MSTR's 5.47 beside EPS -99.08). Unknown
 * earnings leave the multiple as served.
 */
export function priceEarningsOnEarnings(
  multiple: number | null | undefined,
  earnings: number | null | undefined,
): PriceEarnings | undefined {
  if (nonPositive(earnings)) return NOT_MEANINGFUL;
  return typeof multiple === "number" && Number.isFinite(multiple) ? multiple : undefined;
}

/** Negative earnings do not make a security cheaper than a profitable peer. */
export function comparablePriceEarnings(value: PriceEarnings | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** P/E, forward P/E or PEG: N/M below zero, as the multiple says nothing there. */
export function formatPriceEarnings(value: PriceEarnings | null | undefined, precision = 1): string {
  if (value === NOT_MEANINGFUL) return "N/M";
  if (value == null || !Number.isFinite(value)) return "—";
  return value <= 0 ? "N/M" : formatNumber(value, precision);
}

type PriceEarningsField = "trailingPE" | "forwardPE" | "pegRatio";

/**
 * Why each earnings multiple of a fundamentals block is not meaningful, if it
 * is not: a trailing or forward EPS at or below zero, or a multiple that is
 * itself at or below zero. Forward P/E is judged on its own estimate only, so
 * a trailing loss leaves a positive forward multiple alone.
 */
export function notMeaningfulMultiples(
  fundamentals: Pick<Fundamentals, PriceEarningsField | "eps" | "forwardEps"> | undefined,
): Partial<Record<PriceEarningsField, string>> {
  const reasons: Partial<Record<PriceEarningsField, string>> = {};
  if (!fundamentals) return reasons;
  if (nonPositive(fundamentals.eps)) reasons.trailingPE = "trailing EPS is not positive";
  else if (nonPositive(fundamentals.trailingPE)) reasons.trailingPE = "trailing earnings are not positive";
  if (nonPositive(fundamentals.forwardEps)) reasons.forwardPE = "forward EPS is not positive";
  else if (nonPositive(fundamentals.forwardPE)) reasons.forwardPE = "forward earnings are not positive";
  if (nonPositive(fundamentals.pegRatio)) reasons.pegRatio = "P/E or expected growth is not positive";
  return reasons;
}

/**
 * The fundamentals block as JSON exports it: a multiple that is not meaningful
 * reads null, with the reason under `notMeaningful`, never as a number.
 */
export function exportedFundamentals<T extends Fundamentals>(
  fundamentals: T | undefined,
): (Omit<T, PriceEarningsField> & Partial<Record<PriceEarningsField, number | null>> & {
  notMeaningful?: Partial<Record<PriceEarningsField, string>>;
}) | undefined {
  if (!fundamentals) return fundamentals;
  const reasons = notMeaningfulMultiples(fundamentals);
  const fields = Object.keys(reasons) as PriceEarningsField[];
  if (fields.length === 0) return fundamentals;
  return {
    ...fundamentals,
    ...Object.fromEntries(fields.map((field) => [field, null])),
    notMeaningful: reasons,
  };
}
