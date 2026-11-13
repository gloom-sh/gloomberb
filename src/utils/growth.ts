import { NOT_MEANINGFUL } from "./price-earnings";

export { NOT_MEANINGFUL };
export type NotMeaningful = typeof NOT_MEANINGFUL;
/** A growth rate or margin as a fraction (0.25 for 25%), or not meaningful. */
export type Rate = number | NotMeaningful;

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The change from `previous` to `current` as a fraction of `previous` (0.25 for +25%).
 *
 * Off a zero or negative base it is not meaningful: a loss of 10 narrowing to a loss of 5,
 * or turning into a profit of 5, is no percentage of the loss, whatever arithmetic gives
 * (+50% and +150% against its size). Undefined where either figure is missing, or the
 * change overflows a number.
 */
export function growthRate(current: number | null | undefined, previous: number | null | undefined): Rate | undefined {
  if (!finite(current) || !finite(previous)) return undefined;
  if (previous <= 0) return NOT_MEANINGFUL;
  const direct = (current - previous) / previous;
  const growth = Number.isFinite(direct) ? direct : current / previous - 1;
  return Number.isFinite(growth) ? growth : undefined;
}

/**
 * The change in the size of an outflow, a line kept as a negative number (capex, dividends paid):
 * -10 to -12 is +20%, a fifth more spent. A base that is not an outflow (zero or positive) is not
 * meaningful, as it is for growthRate; nor is a period that took money in.
 */
export function outflowGrowthRate(current: number | null | undefined, previous: number | null | undefined): Rate | undefined {
  if (!finite(current) || !finite(previous)) return undefined;
  if (previous >= 0 || current > 0) return NOT_MEANINGFUL;
  return growthRate(-current, -previous);
}

/**
 * `numerator` over `revenue`: a margin, or a cost's share of revenue. Over zero or negative
 * revenue it is not meaningful (a loss over negative revenue would read as a positive margin).
 * Undefined where either figure is missing.
 */
export function revenueMargin(numerator: number | null | undefined, revenue: number | null | undefined): Rate | undefined {
  if (!finite(numerator) || !finite(revenue)) return undefined;
  if (revenue <= 0) return NOT_MEANINGFUL;
  const margin = numerator / revenue;
  return Number.isFinite(margin) ? margin : undefined;
}

/** The number in a rate, or null where it is missing or not meaningful. */
export function rateValue(rate: Rate | null | undefined): number | null {
  return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
}

export function isNotMeaningful(value: unknown): value is NotMeaningful {
  return value === NOT_MEANINGFUL;
}

/** How a not-meaningful rate reads, as a P/E over a loss does. */
export const NOT_MEANINGFUL_TEXT = "N/M";

/**
 * The tone N/M takes where a pane colours by tone (EVTS's rows, KPIS's changes): the text's own, the colour RV draws a
 * P/E over a loss in (components/ui/not-meaningful). Never muted, positive or negative.
 */
export const NOT_MEANINGFUL_TONE = "text" as const;
