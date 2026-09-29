import type { CompositeAxisDomain } from "../chart/composite/types";

/**
 * Decimals that keep neighbouring ticks apart: whole units across a wide
 * range, one or two decimals when the plotted range is narrow.
 */
export function spanDigits(domain: Pick<CompositeAxisDomain, "min" | "max">): number {
  const span = Math.abs(domain.max - domain.min);
  if (!Number.isFinite(span) || span >= 10) return 0;
  if (span >= 1) return 1;
  if (span >= 0.1) return 2;
  return 3;
}

/**
 * A tick formatter whose precision follows the plotted range, so a 2bp range
 * reads 44.8bp / 45.5bp / 46.2bp instead of 45bp / 45bp / 46bp.
 */
export function spanAxisFormatter(
  format: (value: number, digits: number) => string,
): (value: number, domain: CompositeAxisDomain) => string {
  return (value, domain) => format(value, spanDigits(domain));
}

/** Basis points: `235bp`, `44.8bp`. */
export const formatBpAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}bp`);

/** Percent values already in percent units: `4.25%`. */
export const formatPercentAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}%`);
