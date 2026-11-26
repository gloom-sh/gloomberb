import type { CorporateActionsData, EarningsDateStatus, EarningsEpsBasis } from "../../../types/financials";
import { formatNumber, MISSING_VALUE } from "../../../utils/format";
import { growthRate, isNotMeaningful, type NotMeaningful } from "../../../utils/growth";

/**
 * How every earnings surface (ERN, EE, the corporate-actions events and
 * their headless rows) reads and names a reported quarter's EPS basis, an
 * upcoming estimate's when Gloom Cloud names one, and a report date's
 * status. Gloom Cloud resolves one figure per quarter; this keeps the panes
 * from naming it differently.
 */

const BASES: ReadonlySet<string> = new Set<EarningsEpsBasis>(["gaap", "adjusted", "company-adjusted"]);
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

export type EpsBasisName = "GAAP" | "adjusted" | "company-adjusted" | "unknown";

/** What the basis names mean, in every report's metadata. */
export const EPS_BASIS_NOTE = "GAAP: diluted statement EPS. Company-adjusted (coAdj): diluted EPS as the company defines it. A separately identified street actual includes stock compensation. An actual's basis does not establish the estimate's basis. Comparisons use only a release actual identified as being on the basis of the estimate served with it.";
export const EPS_BASIS_UNCONFIRMED = "EPS basis unconfirmed";

interface EpsComparisonRow {
  epsActual?: number | null;
  epsEstimate?: number | null;
  epsBasis?: unknown;
  epsActualSource?: string | null;
  epsComparisonUnconfirmed?: true;
}

/** Older adjusted labels on street actuals can mean only that they did not match statement EPS. */
export function unconfirmedAdjustedEps(row: EpsComparisonRow): boolean {
  return row.epsComparisonUnconfirmed === true || (row.epsActual != null && row.epsBasis === "adjusted"
    && row.epsActualSource !== "press-release" && row.epsActualSource !== "filing");
}

export function displayEarningsEpsBasis(row: EpsComparisonRow): EarningsEpsBasis | null {
  return unconfirmedAdjustedEps(row) ? null : earningsEpsBasis(row.epsBasis);
}

/** A provisional release actual with a known basis was selected upstream against this report's own consensus. */
export function reportedEpsComparison(row: EpsComparisonRow): { difference: number; surprise: NonNullable<Surprise> } | null {
  const basis = displayEarningsEpsBasis(row);
  const { epsActual, epsEstimate } = row;
  if (row.epsActualSource !== "press-release" || (basis !== "gaap" && basis !== "adjusted") || epsActual == null || epsEstimate == null) return null;
  const surprise = epsSurprise(epsActual, epsEstimate);
  return surprise == null ? null : { difference: Math.round((epsActual - epsEstimate) * 100) / 100, surprise };
}

/** The basis as rows, exports and tools name it. */
export function epsBasisName(basis: EarningsEpsBasis | null): EpsBasisName {
  return basis === "gaap" ? "GAAP" : basis ?? "unknown";
}

/** Whether a row names a basis: a reported figure always does, an upcoming estimate only when Gloom Cloud labels it. */
export function showsEpsBasis(row: { epsActual: number | null | undefined; epsBasis: EarningsEpsBasis | null | undefined }): boolean {
  return row.epsActual != null || row.epsBasis != null;
}

/** Whether a reported EPS is the company's press release's: provisional until the calendar's figure replaces it the next day. */
export function isProvisionalActual(row: { epsActual?: number | null; epsActualSource?: string | null }): boolean {
  return row.epsActual != null && row.epsActualSource === "press-release";
}

/**
 * A reported quarter with an actual and no consensus on record says so where
 * its estimate would be, so a blank surprise never reads as a lost figure.
 */
export const NO_CONSENSUS = "no consensus";

/**
 * A report that is out with no actual yet (the calendar fills it the next
 * day, a press release only when it proves the figure) says so where its
 * actual would be, one word everywhere: ERN, the board, EE's detail. A
 * listing abroad's figures come from its own results documents, with Gloom
 * Pro only, so its row without one is not waiting on anything: it keeps its
 * dash.
 */
export const ACTUAL_PENDING = "pending";

/**
 * Gloom Cloud reads a report's date from the calendar for a week after it, so
 * an actual is pending only that long: an older report with none (a 2023
 * report known only from its results filing) has none coming, and keeps its
 * dash.
 */
const PENDING_DAYS = 7;

export function actualPending(
  row: { date?: string | null; epsActual?: number | null; dateStatus?: string | null },
  abroad = false,
  now = Date.now(),
): boolean {
  if (abroad || row.epsActual != null || row.dateStatus !== "reported") return false;
  const date = Date.parse(`${String(row.date ?? "").slice(0, 10)}T00:00:00Z`);
  return !Number.isFinite(date) || now - date <= (PENDING_DAYS + 1) * 86_400_000;
}

/** NO_CONSENSUS where a column is narrow. */
export const NO_CONSENSUS_SHORT = "no est";

/** A beat stated without its estimate (`difference`) still had a consensus. */
export function lacksConsensus(row: { epsActual?: number | null; epsEstimate?: number | null; difference?: number | null; epsBasis?: unknown }): boolean {
  return row.epsBasis !== "company-adjusted" && row.epsActual != null && row.epsEstimate == null && row.difference == null;
}

/** What a provisional figure is, in every report's metadata. */
export const PROVISIONAL_NOTE = "A provisional EPS (or sales) figure is the company's own press release's, read from its results filing minutes after it is out, on the basis the consensus is measured on. The earnings calendar's figure replaces it, usually the next day.";

/** The basis in a table cell or a detail line. */
export function epsBasisShort(basis: EarningsEpsBasis | null): string {
  return basis === "company-adjusted" ? "coAdj" : basis === "gaap" ? "GAAP" : basis === "adjusted" ? "adj" : "?";
}

/**
 * A reported row's detail names a known basis as ERN's Basis column does. An
 * unknown one is left out of the detail, along with any beat; the row's
 * `epsBasis`, its drilldown and ERN's column still say it.
 */
const BASIS_TEXT: Record<EpsBasisName, string> = { GAAP: "GAAP", adjusted: "adj", "company-adjusted": "company-adjusted diluted", unknown: "" };

type EarningsRecord = CorporateActionsData["earnings"][number];

export function earningsActionForReport(row: EarningsRecord): EarningsRecord & { epsComparisonUnconfirmed?: true; surpriseNotMeaningful?: true } {
  const { difference: _difference, surprisePercent: _surprise, ...inputs } = row;
  if (unconfirmedAdjustedEps(row)) return { ...inputs, epsBasis: null, epsComparisonUnconfirmed: true };
  const comparison = reportedEpsComparison(row);
  if (!comparison) return inputs;
  return { ...inputs, difference: comparison.difference,
    ...(isNotMeaningful(comparison.surprise) ? { surpriseNotMeaningful: true } : { surprisePercent: Math.round(comparison.surprise * 10_000) / 100 }) };
}

/**
 * What follows an earnings row's EPS, one phrase per part. A reported row
 * names its basis, whether the figure is provisional, and its beat, or that
 * no consensus is on record for it; one out with no actual yet that it is
 * pending; one still to come whether its date is announced; and both their
 * analysts and an adjusted estimate's basis.
 */
export function earningsDetailParts(earning: EarningsRecord & Pick<EpsComparisonRow, "epsComparisonUnconfirmed">): string[] {
  if (earning.epsActual == null) {
    const status = earningsDateStatus(earning.dateStatus);
    return [status === "reported" ? (actualPending(earning) ? ACTUAL_PENDING : null) : status, earning.epsAnalysts != null ? `${earning.epsAnalysts} analysts` : null,
      earningsEpsBasis(earning.epsBasis) === "adjusted" ? BASIS_TEXT.adjusted : null].filter((part): part is string => !!part);
  }
  const basis = unconfirmedAdjustedEps(earning) ? EPS_BASIS_UNCONFIRMED : BASIS_TEXT[epsBasisName(earningsEpsBasis(earning.epsBasis))];
  const comparison = reportedEpsComparison(earning);
  return [basis, isProvisionalActual(earning) ? "provisional" : null,
    lacksConsensus(earning) ? NO_CONSENSUS
      : comparison == null ? null : `${comparison.difference > 0 ? "+" : ""}${formatNumber(comparison.difference, 2)} vs est`]
    .filter((part): part is string => !!part);
}

/** A reported row names its basis and beat; a pending one whether its date is announced, its analysts and an adjusted estimate's basis. */
export function earningsDetail(earning: EarningsRecord): string {
  const detail = earningsDetailParts(earning).join(", ");
  if (earning.epsActual == null) return detail || "Pending";
  return earning.dateType === "fiscal-period-end" ? ["Period end", detail].filter(Boolean).join("; ") : detail;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The quarter by the month it ends in, e.g. "Jun 2026", from a date or a YYYY-MM period; "-" when it is neither. */
export function quarterLabel(date: string | undefined): string {
  const match = /^(\d{4})-(\d{2})/.exec(date ?? "");
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : MISSING_VALUE;
}

/** A surprise as a fraction of the estimate, N/M against a loss or zero estimate, null without both figures. */
export type Surprise = number | NotMeaningful | null;

/**
 * Actual over estimate minus one. Against an estimate of a loss, or of nothing, it is not
 * meaningful: a loss of 0.10 against 0.20 expected is no percentage of the loss expected.
 */
export function epsSurprise(actual: number | null | undefined, estimate: number | null | undefined): Surprise {
  if (actual == null || estimate == null) return null;
  return growthRate(actual, estimate) ?? null;
}

/** A fiscal quarter end month (YYYY-MM) holds a period end in that month, or a 52/53-week end a few days either side. */
export function inFiscalMonth(periodEnd: string | null | undefined, fiscalPeriod: string | null | undefined): boolean {
  const month = /^(\d{4})-(\d{2})$/.exec(fiscalPeriod ?? "");
  const end = Date.parse(`${periodEnd ?? ""}T00:00:00Z`);
  if (!month || !Number.isFinite(end)) return false;
  const monthEnd = Date.UTC(Number(month[1]), Number(month[2]), 0);
  return end >= monthEnd - 35 * 86_400_000 && end <= monthEnd + 10 * 86_400_000;
}
