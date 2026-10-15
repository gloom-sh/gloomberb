import type { DeclaredDividendAction } from "../types/financials";
import { formatDistributionAmount } from "./format";

/**
 * What a forward dividend yield is everywhere it shows (fundamentals, DVD):
 * the indicated annual rate Gloom Cloud serves over the price, dated by the
 * ex-date of the distribution it annualizes. While no other is announced that
 * is the latest distribution, whose ex-date has passed. Once the next one is
 * declared the rate annualizes it, and its ex-date is still ahead: the basis
 * then names the declared distribution by its ex-date and pay date, and by its
 * amount when Gloom Cloud states one for that ex-date, never a rate "as of" a
 * day that has not come. The amount is only ever the stated one, never the
 * rate divided back.
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

interface DeclaredBasisOptions {
  /** The declared distributions Gloom Cloud states (`declaredDividends`); only the one on the rate's ex-date counts. */
  declared?: readonly DeclaredDividendAction[];
  /** The currency their amounts are in; without it no amount is named. */
  currency?: string | null;
  now?: Date;
}

/** The declared row on the rate's ex-date, as `$0.98`, with its pay date; null when none is stated. */
function statedDeclaration(exDate: string, options: DeclaredBasisOptions): { amount: string; payDate: string | null } | null {
  const row = options.currency ? options.declared?.find((declared) => declared.exDate === exDate) : undefined;
  return row ? { amount: formatDistributionAmount(row.amount, options.currency!), payDate: isoDay(row.payDate) } : null;
}

/**
 * `latest distribution annualized, as of 2026-08-20`, or for a rate dated
 * ahead, `annualized from the declared $0.98 payable 2026-12-10, ex
 * 2026-11-19`, the amount and pay date when they are stated; the basis alone
 * when the date is unknown. `payDate` is the pay date a source states beside
 * that ex-date without a declared row (DVD's summary).
 */
export function forwardDividendBasis(
  asOf: string | Date | null | undefined,
  options: DeclaredBasisOptions & { payDate?: string | Date | null } = {},
): string {
  const exDate = isoDay(asOf);
  if (!isDeclared(exDate, options.now ?? new Date())) return exDate ? `${LATEST_DISTRIBUTION}, as of ${exDate}` : LATEST_DISTRIBUTION;
  const stated = statedDeclaration(exDate, options);
  const payDate = stated?.payDate ?? isoDay(options.payDate);
  return `annualized from the declared ${stated?.amount ?? "distribution"}${payDate ? ` payable ${payDate}` : ""}, ex ${exDate}`;
}

/** The same basis as a pane's short note under the figure: `as of 2026-08-20`, or `declared $0.98` beside the next ex-date it shows. */
export function forwardDividendNote(asOf: string | Date | null | undefined, options: DeclaredBasisOptions = {}): string | null {
  const exDate = isoDay(asOf);
  if (!exDate) return null;
  if (!isDeclared(exDate, options.now ?? new Date())) return `as of ${exDate}`;
  const stated = statedDeclaration(exDate, options);
  return stated ? `declared ${stated.amount}` : "declared";
}
