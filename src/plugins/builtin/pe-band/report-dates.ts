import type { EarningsHistoryPayload } from "../../../api-client/earnings";
import type { FinancialStatement } from "../../../types/financials";
import { statementFieldAvailability } from "../../../utils/financial-statements";
import { newYorkToday } from "../earnings/board-model";

const DAY_MS = 86_400_000;
/** A 52/53-week fiscal quarter ends within days of its month end, never a month away. */
const MONTH_END_TOLERANCE_MS = 10 * DAY_MS;
/** A company reports after its period ends; later than this the report is another quarter's. */
const MAX_REPORT_LAG_MS = 180 * DAY_MS;

/** One reported quarter, reduced to what dates its EPS. */
export interface ReportDate {
  /** New York report date, YYYY-MM-DD. */
  date: string;
  /** Fiscal quarter end month, YYYY-MM. */
  fiscalPeriod: string;
  /** Filing time, when on record. */
  reportedAt: string | null;
}

/**
 * The reports that happened, with the quarter they cover. An upcoming report,
 * one whose date is only expected, and one with no fiscal quarter date nothing.
 */
export function reportDatesFrom(payload: EarningsHistoryPayload): ReportDate[] {
  const asOf = Date.parse(payload.asOf);
  if (!Number.isFinite(asOf)) return [];
  const today = newYorkToday(new Date(asOf));
  return payload.reports.flatMap((report) => (
    report.fiscalPeriod && /^\d{4}-(0[1-9]|1[0-2])$/.test(report.fiscalPeriod) && report.date <= today
      && (report.epsActual != null || report.reportedAt != null)
      ? [{ date: report.date, fiscalPeriod: report.fiscalPeriod, reportedAt: report.reportedAt }] : []
  ));
}

function coversPeriod(periodEnd: number, fiscalPeriod: string): boolean {
  if (new Date(periodEnd).toISOString().slice(0, 7) === fiscalPeriod) return true;
  const monthEnd = Date.UTC(Number(fiscalPeriod.slice(0, 4)), Number(fiscalPeriod.slice(5, 7)), 0);
  return Math.abs(periodEnd - monthEnd) <= MONTH_END_TOLERANCE_MS;
}

/** The filing time when it falls on the report date in both New York and UTC, else the date. */
function publishedAt(report: ReportDate): string {
  const filed = report.reportedAt ? new Date(report.reportedAt) : null;
  return filed && Number.isFinite(filed.getTime()) && filed.toISOString().slice(0, 10) === report.date
    && newYorkToday(filed) === report.date ? report.reportedAt! : report.date;
}

/**
 * When the quarter ended on `periodEnd` was reported. It is the one report
 * whose fiscal quarter month is the period's own month or sits within days of
 * it, and which comes after the period. No report, or two on different dates,
 * leaves the period undated rather than guessed.
 */
function reportedWhen(periodEnd: string, reports: readonly ReportDate[]): string | null {
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  if (!Number.isFinite(end)) return null;
  const matches = reports.filter((report) => {
    const lag = Date.parse(`${report.date}T00:00:00Z`) - end;
    return lag > 0 && lag <= MAX_REPORT_LAG_MS && coversPeriod(end, report.fiscalPeriod);
  });
  if (new Set(matches.map((report) => report.date)).size !== 1) return null;
  return publishedAt(matches.find((report) => report.reportedAt) ?? matches[0]!);
}

/**
 * The statement with its EPS dated by the company's report, only when it has no
 * publication date of its own: a date on record always wins. A fiscal year is
 * dated by the report of its last quarter, which shares its period end. A
 * trailing sum takes the latest of its four quarters from the shared series,
 * so it cannot be known before all four are.
 */
export function datedByReport(row: FinancialStatement, reports: readonly ReportDate[]): FinancialStatement {
  if (!reports.length || typeof row.eps !== "number" || !Number.isFinite(row.eps) || statementFieldAvailability(row, "eps") !== undefined) return row;
  const known = reportedWhen(row.date, reports);
  return known ? { ...row, fieldAvailability: { ...row.fieldAvailability, eps: known } } : row;
}
