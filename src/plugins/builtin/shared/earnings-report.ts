import type { EarningsDateStatus, EarningsEpsBasis } from "../../../types/financials";

/**
 * How every earnings surface (ERN, EE, the corporate-actions events and
 * their headless rows) reads and names a reported quarter's EPS basis and a
 * report date's status. Gloom Cloud resolves one figure per quarter; this
 * keeps the panes from naming it differently.
 */

const BASES: ReadonlySet<string> = new Set<EarningsEpsBasis>(["gaap", "adjusted"]);
const STATUSES: ReadonlySet<string> = new Set<EarningsDateStatus>(["reported", "confirmed", "projected"]);

/** A server value read defensively: anything unrecognised is an unknown basis. */
export function earningsEpsBasis(value: unknown): EarningsEpsBasis | null {
  return typeof value === "string" && BASES.has(value) ? value as EarningsEpsBasis : null;
}

export function earningsDateStatus(value: unknown): EarningsDateStatus | null {
  return typeof value === "string" && STATUSES.has(value) ? value as EarningsDateStatus : null;
}

/** The per-ticker calendar flags an estimated date; it says nothing about a date it does not flag. */
export function dateStatusFromEstimateFlag(isDateEstimate: boolean | null | undefined): EarningsDateStatus | null {
  return isDateEstimate === true ? "projected" : isDateEstimate === false ? "confirmed" : null;
}

export type EpsBasisName = "GAAP" | "adjusted" | "unknown";

/** What the basis names mean, in every report's metadata. */
export const EPS_BASIS_NOTE = "One reported EPS per quarter. GAAP: the quarter's diluted statement EPS. adjusted: the consensus-basis figure the estimate is measured against, which leaves out items the statements include. unknown: no statement on a comparable share basis to tell.";

/** The basis as rows, exports and tools name it. */
export function epsBasisName(basis: EarningsEpsBasis | null): EpsBasisName {
  return basis === "gaap" ? "GAAP" : basis === "adjusted" ? "adjusted" : "unknown";
}

/** The basis in a table cell or a detail line. */
export function epsBasisShort(basis: EarningsEpsBasis | null): string {
  return basis === "gaap" ? "GAAP" : basis === "adjusted" ? "adj" : "?";
}

/** Actual over estimate minus one, against the estimate's size so a negative estimate reads the right way. */
export function epsSurprise(actual: number | null | undefined, estimate: number | null | undefined): number | null {
  if (actual == null || estimate == null || estimate === 0) return null;
  return (actual - estimate) / Math.abs(estimate);
}

/** A fiscal quarter end month (YYYY-MM) holds a period end in that month, or a 52/53-week end a few days either side. */
export function inFiscalMonth(periodEnd: string | null | undefined, fiscalPeriod: string | null | undefined): boolean {
  const month = /^(\d{4})-(\d{2})$/.exec(fiscalPeriod ?? "");
  const end = Date.parse(`${periodEnd ?? ""}T00:00:00Z`);
  if (!month || !Number.isFinite(end)) return false;
  const monthEnd = Date.UTC(Number(month[1]), Number(month[2]), 0);
  return end >= monthEnd - 35 * 86_400_000 && end <= monthEnd + 10 * 86_400_000;
}
