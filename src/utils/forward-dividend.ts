/**
 * What a forward dividend yield is everywhere it shows (fundamentals, DVD):
 * the indicated annual rate Gloom Cloud serves over the price, dated by the
 * ex-date of the distribution it annualizes. While no other is announced that
 * is the latest distribution, whose ex-date has passed. Once the next one is
 * declared the rate annualizes it, and its ex-date is still ahead: the basis
 * then names the declared distribution by its ex-date and pay date, never a
 * rate "as of" a day that has not come.
 */
const LATEST_DISTRIBUTION = "latest distribution annualized";

/** `2026-10-01` from a date or an ISO text; null when it is neither. */
function isoDay(value: string | Date | null | undefined): string | null {
  const text = value instanceof Date ? (Number.isFinite(value.getTime()) ? value.toISOString() : "") : value ?? "";
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** A rate dated by an ex-date after today annualizes a distribution declared and not yet gone ex. */
function isDeclared(exDate: string | null, now: Date): exDate is string {
  return exDate != null && exDate > now.toISOString().slice(0, 10);
}

/**
 * `latest distribution annualized, as of 2026-08-20`, or for a rate dated
 * ahead, `annualized from the declared distribution payable 2026-12-10, ex
 * 2026-11-19`; the basis alone when the date is unknown. `payDate` is the pay
 * date stated beside that ex-date, for a source that pairs them.
 */
export function forwardDividendBasis(
  asOf: string | Date | null | undefined,
  options: { payDate?: string | Date | null; now?: Date } = {},
): string {
  const exDate = isoDay(asOf);
  if (!isDeclared(exDate, options.now ?? new Date())) return exDate ? `${LATEST_DISTRIBUTION}, as of ${exDate}` : LATEST_DISTRIBUTION;
  const payDate = isoDay(options.payDate);
  return `annualized from the declared distribution${payDate ? ` payable ${payDate}` : ""}, ex ${exDate}`;
}

/** The same basis as a pane's short note under the figure: `as of 2026-08-20`, or `declared` beside the next ex-date it shows. */
export function forwardDividendNote(asOf: string | Date | null | undefined, now = new Date()): string | null {
  const exDate = isoDay(asOf);
  if (!exDate) return null;
  return isDeclared(exDate, now) ? "declared" : `as of ${exDate}`;
}
