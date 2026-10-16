import type { CorporateActionsData, EarningsDateStatus, EarningsEpsBasis } from "../../../types/financials";
import { formatNumber } from "../../../utils/format";

/**
 * How every earnings surface (ERN, EE, the corporate-actions events and
 * their headless rows) reads and names a reported quarter's EPS basis, an
 * upcoming estimate's when Gloom Cloud names one, and a report date's
 * status. Gloom Cloud resolves one figure per quarter; this keeps the panes
 * from naming it differently.
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
export const EPS_BASIS_NOTE = "One reported EPS per quarter. GAAP: the quarter's diluted statement EPS. adjusted: the consensus-basis figure the estimate is measured against, which leaves out items the statements include. unknown: no statement on a comparable share basis to tell. An upcoming report's estimate is labelled adjusted when it is the consensus on the adjusted basis the company's reports are on (a REIT's FFO), not a GAAP forecast.";

/** The basis as rows, exports and tools name it. */
export function epsBasisName(basis: EarningsEpsBasis | null): EpsBasisName {
  return basis === "gaap" ? "GAAP" : basis === "adjusted" ? "adjusted" : "unknown";
}

/** Whether a row names a basis: a reported figure always does, an upcoming estimate only when Gloom Cloud labels it. */
export function showsEpsBasis(row: { epsActual: number | null | undefined; epsBasis: EarningsEpsBasis | null | undefined }): boolean {
  return row.epsActual != null || row.epsBasis != null;
}

/** Whether a reported EPS is the company's press release's: provisional until the calendar's figure replaces it the next day. */
export function isProvisionalActual(row: { epsActual?: number | null; epsActualSource?: string | null }): boolean {
  return row.epsActual != null && row.epsActualSource === "press-release";
}

/** What a provisional figure is, in every report's metadata. */
export const PROVISIONAL_NOTE = "A provisional EPS (or sales) figure is the company's own press release's, read from its results filing minutes after it is out, on the basis the consensus is measured on. The earnings calendar's figure replaces it, usually the next day.";

/** The basis in a table cell or a detail line. */
export function epsBasisShort(basis: EarningsEpsBasis | null): string {
  return basis === "gaap" ? "GAAP" : basis === "adjusted" ? "adj" : "?";
}

/** The basis as every earnings table names it: GAAP, adj, basis unknown. */
const BASIS_TEXT: Record<EpsBasisName, string> = { GAAP: "GAAP", adjusted: "adj", unknown: "basis unknown" };

type EarningsRecord = CorporateActionsData["earnings"][number];

/**
 * What follows an earnings row's EPS, one phrase per part. A reported row
 * names its basis, whether the figure is provisional, and its beat; a
 * pending one whether its date is announced, its analysts and an adjusted
 * estimate's basis.
 */
export function earningsDetailParts(earning: EarningsRecord): string[] {
  if (earning.epsActual == null) {
    const status = earningsDateStatus(earning.dateStatus);
    return [status === "reported" ? null : status, earning.epsAnalysts != null ? `${earning.epsAnalysts} analysts` : null,
      earningsEpsBasis(earning.epsBasis) === "adjusted" ? BASIS_TEXT.adjusted : null].filter((part): part is string => !!part);
  }
  return [BASIS_TEXT[epsBasisName(earningsEpsBasis(earning.epsBasis))], isProvisionalActual(earning) ? "provisional" : null,
    earning.difference == null ? null : `${earning.difference > 0 ? "+" : ""}${formatNumber(earning.difference, 2)} vs est`]
    .filter((part): part is string => !!part);
}

/** A reported row names its basis and beat; a pending one whether its date is announced, its analysts and an adjusted estimate's basis. */
export function earningsDetail(earning: EarningsRecord): string {
  const detail = earningsDetailParts(earning).join(", ");
  if (earning.epsActual == null) return detail || "Pending";
  return earning.dateType === "fiscal-period-end" ? `Period end; ${detail}` : detail;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The quarter by the month it ends in, e.g. "Jun 2026", from a date or a YYYY-MM period; "-" when it is neither. */
export function quarterLabel(date: string | undefined): string {
  const match = /^(\d{4})-(\d{2})/.exec(date ?? "");
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : "-";
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
