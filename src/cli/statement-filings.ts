import { apiClient } from "../api-client";
import type { BankFiguresPayload } from "../api-client/bank-figures";
import type { FinancialStatement } from "../types/financials";
import { logFailure } from "../utils/log-failure";
import { nonUsSecListingVenue } from "../utils/sec";

/**
 * Which filing a report's statements come from, and whether a newer quarter's
 * results are out before its statements are. A company releases a quarter's
 * results in an 8-K (Item 2.02, results of operations) weeks before the 10-Q
 * or 10-K that carries its statements, so for those weeks the latest
 * statements are a quarter behind what the company has published.
 */

/** A filing as these reports read it: the form, the day SEC dated it, its accession and its 8-K items. */
export interface PeriodicFiling {
  form: string;
  /** YYYY-MM-DD */
  filed: string;
  accessionNumber: string;
  /** 8-K items, such as `2.02`. */
  items: string[];
  /** The period of report: a 10-Q's or 10-K's balance-sheet date. */
  reportDate?: string;
}

/** The forms the statement reports read: the periodic reports and the 8-K results releases. */
const STATEMENT_FILING_FORMS = ["10-K", "10-Q", "8-K"] as const;
const STATEMENT_FILING_LIMIT = 60;

/**
 * The Gloom Cloud reads the statement and fundamentals reports add to the
 * data service's: a listing's periodic filings and a bank's figures. Kept
 * apart from the data service, so a report run on a stand-in for it reads
 * neither.
 */
export interface StatementReportSources {
  /** The company's 10-K, 10-Q and 8-K filings, newest first. */
  statementFilings(symbol: string): Promise<PeriodicFiling[]>;
  bankFigures(symbol: string): Promise<BankFiguresPayload>;
}

export const cloudStatementReportSources: StatementReportSources = {
  async statementFilings(symbol) {
    const response = await apiClient.getCloudSecFilings({ ticker: symbol, forms: STATEMENT_FILING_FORMS, limit: STATEMENT_FILING_LIMIT });
    // A server that predates the form filter sends every form: the rest are left here.
    return response.filings.flatMap((filing) => {
      const form = filing.form.trim().toUpperCase();
      const base = form.replace(/\/A$/, "");
      if (!(STATEMENT_FILING_FORMS as readonly string[]).includes(base) || !/^\d{4}-\d{2}-\d{2}$/.test(filing.filingDate)) return [];
      return [{
        form,
        filed: filing.filingDate,
        accessionNumber: filing.accessionNumber,
        items: (filing.items ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        ...filing.reportDate ? { reportDate: filing.reportDate } : {},
      }];
    });
  },
  bankFigures: (symbol) => apiClient.getCloudBankFigures(symbol),
};

/** The filing a statement row's period was read from: its form when the filing list names it, and its filed date. */
export interface StatementFiling {
  /** 10-Q or 10-K; null when the filing is not among those listed. */
  form: string | null;
  filed: string;
  accessionNumber: string;
}

/**
 * The 10-Q or 10-K a statement period comes from. A period SEC dated names
 * its filing. Any other is the first of `forms` (not an amendment) whose
 * period of report is the period's date: the report its figures first
 * appeared in. A fiscal fourth quarter's is the 10-K.
 */
export function statementFiling(
  row: FinancialStatement | null | undefined,
  filings: readonly PeriodicFiling[],
  forms: readonly ("10-Q" | "10-K")[],
): StatementFiling | null {
  if (!row) return null;
  const evidence = row.dateSource === "sec" ? row.dateEvidence : undefined;
  if (evidence?.filed && evidence.accessionNumber) {
    return {
      form: filings.find((filing) => filing.accessionNumber === evidence.accessionNumber)?.form ?? null,
      filed: evidence.filed,
      accessionNumber: evidence.accessionNumber,
    };
  }
  const report = filings
    .filter((filing) => (forms as readonly string[]).includes(filing.form) && filing.reportDate === row.date)
    .sort((left, right) => left.filed.localeCompare(right.filed))[0];
  return report ? { form: report.form, filed: report.filed, accessionNumber: report.accessionNumber } : null;
}

/** "2026-06-30, 10-Q filed 2026-08-06": a statement heading's period and the filing it is from. */
export function statementPeriodText(date: string, filing: StatementFiling | null): string {
  if (!filing) return date;
  return `${date}, ${filing.form ? `${filing.form} ` : ""}filed ${filing.filed}`;
}

/** A newer quarter's results, out in an 8-K before its statements. */
export interface ResultsRelease {
  /** The fiscal quarter, when the fiscal year's end is known and the quarter falls on its grid. */
  fiscalQuarter: 1 | 2 | 3 | 4 | null;
  /** The month the quarter ends in, YYYY-MM. */
  periodMonth: string;
  form: "8-K";
  filed: string;
  accessionNumber: string;
  /** The report its statements come with: the 10-K for a fiscal fourth quarter. */
  statementsForm: "10-Q" | "10-K" | null;
  /** That report, when it is filed already and the statements here are not from it yet. */
  periodicReport: { form: string; filed: string; accessionNumber: string } | null;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Months since year 0 of the month a period ends in. A 52-53 week year can
 * end in the first days of the next month (Saturday 4 Jul for June): those
 * belong to the month before.
 */
function periodMonthIndex(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const index = Number(match[1]) * 12 + Number(match[2]) - 1;
  return Number(match[3]) <= 7 ? index - 1 : index;
}

/** The last day of a month index, YYYY-MM-DD. */
function monthEnd(index: number): string {
  const year = Math.floor(index / 12), month = index % 12;
  return new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
}

function monthText(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The newest quarter whose results an 8-K (Item 2.02) released after the
 * statements' latest period, or null. An 8-K counts only once the quarter
 * after the latest period has ended: a release before that is the latest
 * period's own, or an update inside the quarter. Of several such releases,
 * the newest quarter's first one. The fiscal quarter is read on the grid of
 * the latest annual period's year end.
 */
export function detectResultsRelease({ latestQuarter, latestAnnual, filings }: {
  /** Period end dates, YYYY-MM-DD. */
  latestQuarter: string | null | undefined;
  latestAnnual: string | null | undefined;
  filings: readonly PeriodicFiling[];
}): ResultsRelease | null {
  const latest = [latestQuarter, latestAnnual].filter((date): date is string => !!date).sort().at(-1);
  const anchor = latest ? periodMonthIndex(latest) : null;
  if (anchor == null) return null;
  // Quarters past the latest period whose end the release came after: 1 for the next quarter.
  const quartersAfter = (filed: string) => {
    let quarters = 0;
    while (monthEnd(anchor + 3 * (quarters + 1)) < filed) quarters++;
    return quarters;
  };
  const releases = filings
    .filter((filing) => filing.form === "8-K" && filing.items.includes("2.02"))
    .map((filing) => ({ filing, quarters: quartersAfter(filing.filed) }))
    .filter(({ quarters }) => quarters > 0)
    .sort((left, right) => right.quarters - left.quarters || left.filing.filed.localeCompare(right.filing.filed));
  const newest = releases[0];
  if (!newest) return null;
  const period = anchor + 3 * newest.quarters;
  const yearEnd = latestAnnual ? periodMonthIndex(latestAnnual) : null;
  const offset = yearEnd == null ? null : (((period - yearEnd) % 12) + 12) % 12;
  const fiscalQuarter = offset != null && offset % 3 === 0 ? (offset === 0 ? 4 : offset / 3) as ResultsRelease["fiscalQuarter"] : null;
  const statementsForm = fiscalQuarter == null ? null : fiscalQuarter === 4 ? "10-K" : "10-Q";
  // Filed on or after the release, so not the report the latest statements came from.
  const periodic = filings
    .filter((filing) => /^10-[KQ]$/.test(filing.form) && filing.filed >= newest.filing.filed && (!statementsForm || filing.form === statementsForm))
    .sort((left, right) => left.filed.localeCompare(right.filed))[0];
  return {
    fiscalQuarter,
    periodMonth: monthText(period),
    form: "8-K",
    filed: newest.filing.filed,
    accessionNumber: newest.filing.accessionNumber,
    statementsForm,
    periodicReport: periodic ? { form: periodic.form, filed: periodic.filed, accessionNumber: periodic.accessionNumber } : null,
  };
}

/** "Q3 (Sep 2026) results released 2026-10-13 (8-K); statements arrive with the 10-Q." */
export function resultsReleaseText(release: ResultsRelease): string {
  const [year, month] = release.periodMonth.split("-");
  const period = `${MONTH_NAMES[Number(month) - 1]} ${year}`;
  const quarter = release.fiscalQuarter ? `Q${release.fiscalQuarter} (${period})` : `Quarter to ${period}`;
  const report = release.statementsForm ?? "next 10-Q or 10-K";
  const after = release.periodicReport
    ? `the ${release.periodicReport.form} followed on ${release.periodicReport.filed} and its statements are not in yet`
    : `statements arrive with the ${report}`;
  return `${quarter} results released ${release.filed} (8-K); ${after}.`;
}

/** What a statement report shows about its latest periods' filings. */
export interface StatementFilingsReport {
  latestQuarter: (StatementFiling & { date: string }) | null;
  latestAnnual: (StatementFiling & { date: string }) | null;
  resultsRelease: ResultsRelease | null;
}

/**
 * The filings behind a report's latest statements, read for a US listing
 * with statements; nothing (and no request) for any other. A failed read
 * leaves the filed dates SEC-dated statements carry and no release line.
 */
export async function loadStatementFilings(
  sources: StatementReportSources | undefined,
  listing: { symbol: string; exchange?: string },
  latest: { quarter: FinancialStatement | null | undefined; annual: FinancialStatement | null | undefined },
): Promise<StatementFilingsReport> {
  const filings = sources && (latest.quarter || latest.annual) && !nonUsSecListingVenue(listing.symbol, listing.exchange)
    ? await sources.statementFilings(listing.symbol)
      .catch(logFailure("cli.statement-filings", "Reading the statement filings failed", [] as PeriodicFiling[]))
    : [];
  const withDate = (row: FinancialStatement | null | undefined, forms: readonly ("10-Q" | "10-K")[]) => {
    const filing = statementFiling(row, filings, forms);
    return row && filing ? { date: row.date, ...filing } : null;
  };
  return {
    latestQuarter: withDate(latest.quarter, ["10-Q", "10-K"]),
    latestAnnual: withDate(latest.annual, ["10-K"]),
    resultsRelease: filings.length > 0
      ? detectResultsRelease({ latestQuarter: latest.quarter?.date, latestAnnual: latest.annual?.date, filings })
      : null,
  };
}
