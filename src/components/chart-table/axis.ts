import type { CompositeAxisValueFormatter } from "../chart/composite/format";
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
 *
 * `valueDigits` is the data's own precision, as its table reads it. The value
 * tags on the axis (the last value, a level, the cursor) keep it, or the
 * ticks' digits where those are finer, so a 3.75% level on an axis ticked
 * 3.5% / 4.0% reads 3.75%. Without it the tags read as the ticks do.
 */
export function spanAxisFormatter(
  format: (value: number, digits: number) => string,
  valueDigits?: number | ((value: number) => number),
): CompositeAxisValueFormatter {
  const tick = (value: number, domain: CompositeAxisDomain) => format(value, spanDigits(domain));
  if (valueDigits === undefined) return tick;
  const ownDigits = typeof valueDigits === "number" ? () => valueDigits : valueDigits;
  return Object.assign(tick, {
    tag: (value: number, domain: CompositeAxisDomain) => format(value, Math.max(spanDigits(domain), ownDigits(value))),
  });
}

/** Basis points: `235bp` on the ticks, a tag to the tenth (`44.8bp`). */
export const formatBpAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}bp`, 1);

/** Percent values already in percent units: `4.5%` on the ticks, a tag to the bp (`4.25%`). */
export const formatPercentAxis = spanAxisFormatter((value, digits) => `${value.toFixed(digits)}%`, 2);

/**
 * Moves already in percent units, signed as a return reads: `+4%`, `0%`,
 * `-0.25%`, and the cursor's `+5.31%`. Two decimals at most, trailing zeros
 * dropped, so round ticks stay short.
 */
export function formatChangePercentAxis(value: number): string {
  const fixed = value.toFixed(2).replace(/\.?0+$/, "");
  if (!/[1-9]/.test(fixed)) return "0%";
  return `${value > 0 ? "+" : ""}${fixed}%`;
}

const COMPACT_UNITS = [
  { divisor: 1e12, suffix: "T" },
  { divisor: 1e9, suffix: "B" },
  { divisor: 1e6, suffix: "M" },
  { divisor: 1e3, suffix: "k" },
  { divisor: 1, suffix: "" },
] as const;

/**
 * Amounts and counts in one compact unit for the whole axis (`50B`, `91.25B`,
 * `600k`), with the decimals the plotted range needs so ticks never repeat.
 */
export function formatCompactAxis(value: number, domain: CompositeAxisDomain): string {
  if (value === 0) return "0";
  const top = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  const unit = COMPACT_UNITS.find((entry) => top >= entry.divisor) ?? COMPACT_UNITS.at(-1)!;
  const digits = spanDigits({ min: domain.min / unit.divisor, max: domain.max / unit.divisor });
  return `${(value / unit.divisor).toFixed(digits)}${unit.suffix}`;
}
