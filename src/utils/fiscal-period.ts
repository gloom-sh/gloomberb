import type { FinancialStatement } from "../types/financials";

/**
 * The month a period end closes. A 52/53-week period that ends in a month's
 * first week (Jan 3, 2026) closes the month before, as its filer counts it.
 */
function closingMonth(date: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  let year = Number(match[1]);
  let month = Number(match[2]);
  if (Number(match[3]) <= 7) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return month >= 1 && month <= 12 ? { year, month } : null;
}

/** The month the issuer's fiscal year ends, from its latest annual statement. */
export function fiscalYearEndMonth(annualStatements: readonly Pick<FinancialStatement, "date">[]): number | null {
  const latest = annualStatements.reduce<string | null>((max, { date }) => (!max || date > max ? date : max), null);
  return latest ? closingMonth(latest)?.month ?? null : null;
}

/**
 * A fiscal period as issuers and Bloomberg name it: `FY2026` for a year,
 * `Q4 FY26` for a quarter. A fiscal year is named by the calendar year it
 * ends in. Without a fiscal calendar, or for a period off it (a transition
 * period, an off-cycle observation), the period end date is shown instead.
 */
export function fiscalPeriodLabel(date: string, kind: "annual" | "quarterly", yearEndMonth: number | null): string {
  const closing = closingMonth(date);
  if (!closing || yearEndMonth == null) return date.slice(0, 10);
  const offset = (closing.month - yearEndMonth + 12) % 12;
  if (kind === "annual") return offset === 0 ? `FY${closing.year}` : date.slice(0, 10);
  if (offset % 3 !== 0) return date.slice(0, 10);
  const fiscalYear = closing.month <= yearEndMonth ? closing.year : closing.year + 1;
  return `Q${offset === 0 ? 4 : offset / 3} FY${String(fiscalYear).slice(-2)}`;
}

/** A trailing-twelve-month period by the quarter it runs to: `TTM Q3 FY26`. */
export function ttmPeriodLabel(periodEnd: string | undefined, yearEndMonth: number | null): string {
  return periodEnd ? `TTM ${fiscalPeriodLabel(periodEnd, "quarterly", yearEndMonth)}` : "TTM";
}
