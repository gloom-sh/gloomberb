import type { FinancialStatement } from "../types/financials";

/**
 * How net debt treats the lease liabilities a listing's balance sheets report (docs/financial-ratios.md#leases):
 *
 * - `included`: added to total debt. IFRS 16 puts every lessee lease on the balance sheet and reports EBITDA before
 *   lease costs, so leverage with the leases in is like for like (IAG's June 2026 balance sheet: 6.96bn of
 *   borrowings, 6.91bn of leases, 9.18bn of cash).
 * - `excluded`: a US GAAP filer, whose statements are dated by its SEC filings. Its finance leases are already in
 *   total debt and its operating lease cost is in EBITDA, so its operating leases stay out.
 *
 * Gloom Cloud's enterprise value check bridges the same way.
 */
export type LeaseBasis = "included" | "excluded";

type LeaseLines = Pick<FinancialStatement, "capitalLeaseObligations" | "dateSource">;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The listing's lease basis, or undefined when no balance sheet on file reports lease liabilities. */
export function leaseBasis(statements: Iterable<LeaseLines>): LeaseBasis | undefined {
  let leases = false;
  let usGaap = false;
  for (const statement of statements) {
    if (finite(statement.capitalLeaseObligations) && statement.capitalLeaseObligations > 0) leases = true;
    if (statement.dateSource === "sec") usGaap = true;
  }
  return !leases ? undefined : usGaap ? "excluded" : "included";
}

/** Amounts are whole units; some providers round a leg to the thousand. */
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1_000, Math.abs(a) * 1e-6);

/**
 * A balance sheet's total debt and lease liabilities. A total that already holds the lease line (long-term and
 * current debt plus leases) is read as the borrowings beside it, so the leases count once. Undefined without both
 * lines: a missing lease line is never zero.
 */
export function debtAndLeases(
  statement: Pick<FinancialStatement, "totalDebt" | "capitalLeaseObligations" | "longTermDebt" | "currentDebt">,
): { totalDebt: number; leases: number } | undefined {
  const total = statement.totalDebt;
  const leases = statement.capitalLeaseObligations;
  if (!finite(total) || !finite(leases) || leases < 0) return undefined;
  const { longTermDebt: long, currentDebt: current } = statement;
  const holds = leases > 0 && (finite(long) || finite(current)) && close(total, (long ?? 0) + (current ?? 0) + leases);
  return { totalDebt: holds ? total - leases : total, leases };
}
