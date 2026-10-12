/**
 * What a forward dividend yield is everywhere it shows (fundamentals, DVD):
 * the indicated annual rate Gloom Cloud serves, the latest regular
 * distribution annualized, over the price. It is dated by that
 * distribution's ex-date.
 */
const FORWARD_DIVIDEND_BASIS = "latest distribution annualized";

/** `latest distribution annualized, as of 2026-10-01`; the basis alone when the date is unknown. */
export function forwardDividendBasis(asOf: string | Date | null | undefined): string {
  const text = asOf instanceof Date ? (Number.isFinite(asOf.getTime()) ? asOf.toISOString() : "") : asOf ?? "";
  const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  return date ? `${FORWARD_DIVIDEND_BASIS}, as of ${date}` : FORWARD_DIVIDEND_BASIS;
}
