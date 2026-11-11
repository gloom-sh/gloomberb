import { apiClient } from "../api-client";
import type { BankFiguresPayload } from "../api-client/bank-figures";
import type { ExchangeAnnouncementsPayload } from "../api-client/exchange-announcements";
import type { FinancialStatement } from "../types/financials";
import { fetchOfferingFilings, type OfferingFiling } from "../utils/cash-runway";
import { logFailure } from "../utils/log-failure";
import { parsePublicTickerKey } from "../utils/exchanges";
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

/** A report a statement period is read from: a US filer's 10-Q or 10-K, a foreign issuer's 20-F or 40-F annual report. */
type PeriodicForm = "10-Q" | "10-K" | "20-F" | "40-F";
const ANNUAL_REPORT_FORMS: readonly PeriodicForm[] = ["10-K", "20-F", "40-F"];

/** The forms the statement reports read: the periodic reports and the 8-K results releases. */
const STATEMENT_FILING_FORMS = ["10-K", "10-Q", "8-K", "20-F", "40-F"] as const;
const STATEMENT_FILING_LIMIT = 60;

/**
 * The Gloom Cloud reads the statement and fundamentals reports add to the
 * data service's: a listing's periodic filings and a bank's figures. Kept
 * apart from the data service, so a report run on a stand-in for it reads
 * neither.
 */
export interface StatementReportSources {
  /** The company's 10-K, 10-Q, 8-K, 20-F and 40-F filings, newest first. */
  statementFilings(symbol: string): Promise<PeriodicFiling[]>;
  bankFigures(symbol: string): Promise<BankFiguresPayload>;
  /** The company's latest offering prospectuses (424B5, 424B4), newest first. */
  offeringFilings?(symbol: string): Promise<OfferingFiling[]>;
  /** An HKEX company's HKEXnews announcements, newest first. */
  exchangeAnnouncements?(listing: { symbol: string; exchange: string }): Promise<ExchangeAnnouncementsPayload>;
}

/** HKEXnews announcements read for a report: a company buying back shares files a return a day, so a year's results need the latest 100. */
const RESULTS_ANNOUNCEMENT_LIMIT = 100;

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
  offeringFilings: (symbol) => fetchOfferingFilings(apiClient, symbol),
  exchangeAnnouncements: (listing) => apiClient.getCloudExchangeAnnouncements({ ...listing, limit: RESULTS_ANNOUNCEMENT_LIMIT }),
};

/**
 * A US listing's latest offering prospectuses, for the note that its cash
 * predates one; nothing (and no request) for any other listing, or when
 * `wanted` is false. A failed read leaves the note out.
 */
export async function loadOfferingFilings(
  sources: StatementReportSources | undefined,
  listing: { symbol: string; exchange?: string },
  wanted: boolean,
): Promise<OfferingFiling[]> {
  if (!wanted || !sources?.offeringFilings || nonUsSecListingVenue(listing.symbol, listing.exchange)) return [];
  return sources.offeringFilings(listing.symbol)
    .catch(logFailure("cli.statement-filings", "Reading the offering filings failed", [] as OfferingFiling[]));
}

/** The filing a statement row's period was read from: its form when the filing list names it, and its filed date. */
export interface StatementFiling {
  /** 10-Q, 10-K, 20-F or 40-F; null when the filing is not among those listed. */
  form: string | null;
  filed: string;
  accessionNumber: string;
}

/**
 * The report a statement period comes from. A period SEC dated names its
 * filing. Any other is the first of `forms` (not an amendment) whose period
 * of report is the period's date: the report its figures first appeared in.
 * A fiscal fourth quarter's is the 10-K.
 */
export function statementFiling(
  row: FinancialStatement | null | undefined,
  filings: readonly PeriodicFiling[],
  forms: readonly PeriodicForm[],
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

/**
 * About when the period `months` after one ending on `date` ends, YYYY-MM-DD:
 * a month's last day steps to month ends (30 Jun to 30 Sep), any other day to
 * the same day (Costco's 15 Feb to 15 May, for a quarter that ends on 10 May),
 * or the shorter month's last. For a 52-53 week year it is within a week of
 * the quarter's end; a 16-week fourth quarter (Costco's) ends up to three
 * weeks later, and its release comes weeks after that.
 */
function monthsAfter(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const lastDay = (index: number) => new Date(Date.UTC(Math.floor(index / 12), (index % 12) + 1, 0)).getUTCDate();
  const from = year * 12 + month - 1, to = from + months;
  const next = day === lastDay(from) ? lastDay(to) : Math.min(day, lastDay(to));
  return `${monthText(to)}-${String(next).padStart(2, "0")}`;
}

function monthText(index: number): string {
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The newest quarter whose results an 8-K (Item 2.02) released after the
 * statements' latest period, or null. An 8-K counts only once the quarter
 * after the latest period has ended, three months on from its end date: a
 * release before that is the latest period's own, or an update inside the
 * quarter. Of several such releases, the newest quarter's first one. The
 * fiscal quarter is read on the grid of the latest annual period's year end.
 */
export function detectResultsRelease({ latestQuarter, latestAnnual, filings }: {
  /** Period end dates, YYYY-MM-DD. */
  latestQuarter: string | null | undefined;
  latestAnnual: string | null | undefined;
  filings: readonly PeriodicFiling[];
}): ResultsRelease | null {
  const latest = [latestQuarter, latestAnnual].filter((date): date is string => !!date).sort().at(-1);
  const anchor = latest ? periodMonthIndex(latest) : null;
  if (!latest || anchor == null) return null;
  // Quarters past the latest period whose end the release came after: 1 for the next quarter.
  const quartersAfter = (filed: string) => {
    let quarters = 0;
    while (monthsAfter(latest, 3 * (quarters + 1)) < filed) quarters++;
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

/** A results announcement or business update on HKEXnews, as a statement report cites it. */
export interface ResultsAnnouncement {
  kind: "annual results" | "interim results" | "quarterly results" | "business update";
  headline: string;
  /** The day it was released in Hong Kong, YYYY-MM-DD. */
  announced: string;
  url: string;
}

/**
 * An HKEX company's statements set against its HKEXnews announcements: the
 * announcement that released the latest period's results, which is when its
 * figures were first published, and what was released after it, whose
 * figures the statements do not have: the newest results announcement, and
 * a business update newer than that.
 */
export interface ExchangeResults {
  publisher: "HKEXnews";
  latest: (ResultsAnnouncement & { date: string }) | null;
  newer: ResultsAnnouncement[];
}

const RESULTS_TYPES: Readonly<Record<string, ResultsAnnouncement["kind"]>> = {
  "Final Results": "annual results",
  "Interim Results": "interim results",
  "Quarterly Results": "quarterly results",
};
const BUSINESS_UPDATE_TYPE = "Other - Business Update";
// The listing rules give three months for annual results and two for interim; a late one still counts.
const RESULTS_WINDOW_DAYS = 120;
const HONG_KONG_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit" });

function resultsKind(types: readonly string[]): ResultsAnnouncement["kind"] | null {
  // An annual results announcement that also updates the business is the results.
  for (const type of types) if (RESULTS_TYPES[type]) return RESULTS_TYPES[type]!;
  return types.includes(BUSINESS_UPDATE_TYPE) ? "business update" : null;
}

/**
 * The results announcements behind an HKEX company's latest statement period
 * (`latestPeriod`, YYYY-MM-DD): the first results announcement within 120
 * days after the period ends; and released after that one, the newest
 * results announcement and a business update newer than it. Null without a
 * latest period.
 */
export function matchExchangeResults(
  latestPeriod: string | null | undefined,
  announcements: ExchangeAnnouncementsPayload["announcements"],
): ExchangeResults | null {
  if (!latestPeriod || !/^\d{4}-\d{2}-\d{2}$/.test(latestPeriod)) return null;
  const cited = announcements.flatMap((item): ResultsAnnouncement[] => {
    const kind = resultsKind(item.types);
    const time = Date.parse(item.date);
    return kind && Number.isFinite(time)
      ? [{ kind, headline: item.headline, announced: HONG_KONG_DAY.format(time), url: item.url }]
      : [];
  }).sort((left, right) => left.announced.localeCompare(right.announced));
  const windowEnd = new Date(Date.parse(`${latestPeriod}T00:00:00Z`) + RESULTS_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const own = cited.find((item) => item.kind !== "business update" && item.announced > latestPeriod && item.announced <= windowEnd);
  const later = cited.filter((item) => item !== own && item.announced > (own?.announced ?? latestPeriod));
  const results = later.filter((item) => item.kind !== "business update").at(-1);
  const update = later.filter((item) => item.kind === "business update" && item.announced > (results?.announced ?? "")).at(-1);
  return {
    publisher: "HKEXnews",
    latest: own ? { date: latestPeriod, ...own } : null,
    newer: [results, update].filter((item): item is ResultsAnnouncement => !!item),
  };
}

const RESULTS_PERIOD: Readonly<Record<ResultsAnnouncement["kind"], string>> = {
  "annual results": "annual period",
  "interim results": "half year",
  "quarterly results": "quarter",
  "business update": "period",
};

/**
 * "Latest half year 2026-06-30, interim results announced 2026-08-20
 * (HKEXnews)." and what came out after it, as US statements name their 10-Q
 * and a newer 8-K.
 */
export function exchangeResultsNotes(results: ExchangeResults): string[] {
  const { latest, newer, publisher } = results;
  const kind = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;
  return [
    ...latest ? [`Latest ${RESULTS_PERIOD[latest.kind]} ${latest.date}, ${latest.kind} announced ${latest.announced} (${publisher}).`] : [],
    ...newer.map((item) => item.kind === "business update"
      ? `Business update announced ${item.announced} (${publisher}), after the latest statements: "${item.headline}".`
      : `${kind(item.kind)} announced ${item.announced} (${publisher}); their statements are not in yet.`),
  ];
}

/** What a statement report shows about its latest periods' filings. */
export interface StatementFilingsReport {
  latestQuarter: (StatementFiling & { date: string }) | null;
  latestAnnual: (StatementFiling & { date: string }) | null;
  resultsRelease: ResultsRelease | null;
  /** An HKEX company's results announcements on HKEXnews; absent for any other listing. */
  exchangeResults?: ExchangeResults | null;
  /** The company's newest annual report form: 10-K for a US filer, 20-F or 40-F for a foreign issuer; null when none was read. */
  annualReportForm: string | null;
}

/** Whether an annual report form is a foreign issuer's: a 20-F, or a Canadian company's 40-F. */
export function isForeignIssuerForm(form: string | null | undefined): boolean {
  return form === "20-F" || form === "40-F";
}

/**
 * The filings behind a report's latest statements, read for a US listing
 * with statements, and an HKEX listing's results announcements; nothing
 * (and no request) for any other. A failed read leaves the filed dates
 * SEC-dated statements carry and no release or announcement line.
 */
export async function loadStatementFilings(
  sources: StatementReportSources | undefined,
  listing: { symbol: string; exchange?: string },
  latest: { quarter: FinancialStatement | null | undefined; annual: FinancialStatement | null | undefined },
): Promise<StatementFilingsReport> {
  const venue = nonUsSecListingVenue(listing.symbol, listing.exchange);
  const latestPeriod = [latest.quarter?.date, latest.annual?.date].filter((date): date is string => !!date).sort().at(-1);
  const exchangeResults = sources?.exchangeAnnouncements && latestPeriod && venue === "HKEX"
    ? sources.exchangeAnnouncements({ symbol: parsePublicTickerKey(listing.symbol).symbol.replace(/\.HK$/i, ""), exchange: venue })
      .then((payload) => matchExchangeResults(latestPeriod, payload.announcements))
      .catch(logFailure("cli.statement-filings", "Reading the HKEXnews announcements failed", null))
    : null;
  const filings = sources && (latest.quarter || latest.annual) && !venue
    ? await sources.statementFilings(listing.symbol)
      .catch(logFailure("cli.statement-filings", "Reading the statement filings failed", [] as PeriodicFiling[]))
    : [];
  const withDate = (row: FinancialStatement | null | undefined, forms: readonly PeriodicForm[]) => {
    const filing = statementFiling(row, filings, forms);
    return row && filing ? { date: row.date, ...filing } : null;
  };
  // Newest first, as listed; an amendment is not the report itself.
  const annualReport = [...filings].sort((left, right) => right.filed.localeCompare(left.filed))
    .find((filing) => (ANNUAL_REPORT_FORMS as readonly string[]).includes(filing.form));
  return {
    latestQuarter: withDate(latest.quarter, ["10-Q", "10-K"]),
    latestAnnual: withDate(latest.annual, ANNUAL_REPORT_FORMS),
    resultsRelease: filings.length > 0
      ? detectResultsRelease({ latestQuarter: latest.quarter?.date, latestAnnual: latest.annual?.date, filings })
      : null,
    annualReportForm: annualReport?.form ?? null,
    ...exchangeResults ? { exchangeResults: await exchangeResults } : {},
  };
}
