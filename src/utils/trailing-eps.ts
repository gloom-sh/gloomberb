import type { EarningsField, FinancialStatement } from "../types/financials";
import { areNearbyFinancialPeriodEnds } from "./financial-statements";
import { hasStatementGap } from "./statement-gaps";

const DAY_MS = 86_400_000;

/** A per-share amount the row reports: finite, not declared unavailable, and diluted EPS on a resolved share basis. */
function reportedEarnings(row: FinancialStatement, field: EarningsField): number | null {
  if (hasStatementGap(row, field) || (field === "eps" && row.epsBasis?.status === "unresolved")) return null;
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const consecutiveQuarters = (earlier: string, later: string) => {
  const days = (Date.parse(later) - Date.parse(earlier)) / DAY_MS;
  return days >= 60 && days <= 120;
};

/**
 * The EPS of four consecutive quarters (oldest first) when one of them is a
 * fiscal fourth quarter with no EPS of its own, as since 2021 a 10-K states
 * the year but not its last quarter: the fiscal year's EPS, plus this fiscal
 * year's quarters to date, less the same quarters a year earlier. The quarter
 * itself is not given an EPS, since a year's EPS is not the sum of its
 * quarters'. Null unless exactly one quarter lacks the line without declaring
 * it unavailable, a fiscal year in the same currency ends with that quarter,
 * and the year and its three earlier quarters report the line. Any input on
 * an unresolved split basis, or two inputs on different share bases, leave it
 * unknown. `inputs` are the rows the value reads, for its availability.
 */
export function trailingEpsAcrossFiscalYearEnd(
  window: readonly FinancialStatement[],
  quarterlyStatements: readonly FinancialStatement[],
  annualStatements: readonly FinancialStatement[],
  field: EarningsField,
): { value: number; inputs: FinancialStatement[] } | null {
  if (window.length !== 4) return null;
  const unreported = window.filter((row) => reportedEarnings(row, field) === null);
  if (unreported.length !== 1) return null;
  const fourth = unreported[0]!;
  // A declared gap or an unverified share basis is a figure withheld, not one missing.
  if (hasStatementGap(fourth, field) || (field === "eps" && fourth.epsBasis?.status === "unresolved")) return null;
  const years = annualStatements.filter((row) => areNearbyFinancialPeriodEnds(row.date, fourth.date));
  if (years.length !== 1 || years[0]!.currency !== fourth.currency) return null;
  const year = years[0]!;
  const yearValue = reportedEarnings(year, field);
  if (yearValue === null) return null;

  const sorted = [...quarterlyStatements].sort((a, b) => a.date.localeCompare(b.date));
  const end = sorted.findIndex((row) => row.date === fourth.date);
  const earlier = end < 3 ? [] : sorted.slice(end - 3, end);
  if (earlier.length !== 3 || [...earlier, fourth].some((row, index, rows) => (
    row.currency !== fourth.currency || (index > 0 && !consecutiveQuarters(rows[index - 1]!.date, row.date))
  ))) return null;
  // The window's quarters before the fourth are that year's last ones.
  const position = window.indexOf(fourth);
  if (window.slice(0, position).some((row, index) => row.date !== earlier[3 - position + index]!.date)) return null;

  const after = window.slice(position + 1);
  const before = earlier.slice(0, 3 - position);
  const inputs = [year, ...before, ...after];
  if ([...earlier, ...after].some((row) => reportedEarnings(row, field) === null)) return null;
  const bases = new Set([...window, year, ...earlier].flatMap((row) => row.shareBasis ?? []));
  if (bases.size > 1) return null;
  const sum = (rows: readonly FinancialStatement[]) => rows.reduce((total, row) => total + reportedEarnings(row, field)!, 0);
  return { value: yearValue + sum(after) - sum(before), inputs };
}
