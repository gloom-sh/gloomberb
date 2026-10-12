import type { SecFilingDocument, SecFilingItem } from "../types/data-provider";
import type { FinancialStatement, IncomeStatementSource, StatementGapField } from "../types/financials";
import { INCOME_STATEMENT_FIELDS } from "../utils/income-statement";
import { createSecEpsBasisResolver } from "../utils/sec-eps-basis";
import { truncateWithEllipsis } from "../utils/text-wrap";
import { decodeHtmlEntities } from "../utils/html-entities";
import { recordOrNull } from "../utils/guards";
import {
  PDF_FALLBACK_MESSAGE,
  extractFilingContent,
  isPdfDocument,
} from "./sec-edgar/content";
import { parseSecAcceptanceTime } from "./sec-edgar/acceptance-time";
import { DEFAULT_SEC_FROM, DEFAULT_SEC_USER_AGENT } from "./sec-edgar/identity";
import { secFourthQuarters, withGuardedFourthQuarters, type SecFourthQuarter } from "./sec-edgar/fourth-quarter";

export { extractFilingContent } from "./sec-edgar/content";

const LOOKUP_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
const FETCH_TIMEOUT_MS = 15_000;

type LookupEntry = {
  cik: string;
  exchange?: string;
  name?: string;
};

type CompanyFactsEntry = {
  concept?: string;
  tagPriority?: number;
  accn?: string;
  start?: string;
  end?: string;
  val?: number;
  fy?: number | null;
  fp?: string | null;
  form?: string;
  filed?: string;
  frame?: string;
  /** A fact reporting the same figure for this span carries SEC's calendar-quarter frame. */
  framedQuarter?: boolean;
};

type CompanyFactsStatementField = {
  field: keyof FinancialStatement;
  tags: string[];
  units: string[];
  periodType: "duration" | "instant";
  transform?: (value: number) => number;
  /** Last tag, used only while it measures the same thing as the filer's other tags. */
  sameMeasureFallback?: string;
};

export type SecCompanyFactsStatements = {
  annualStatements: FinancialStatement[];
  quarterlyStatements: FinancialStatement[];
  /** Full years and fourth quarters SEC's filings support, for checking a vendor's quarters. */
  fourthQuarters?: SecFourthQuarter[];
};

const COMPANY_FACTS_STATEMENT_FIELDS: CompanyFactsStatementField[] = [
  {
    field: "totalRevenue",
    tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenuesNetOfInterestExpense"],
    units: ["USD"],
    periodType: "duration",
    sameMeasureFallback: "RevenuesNetOfInterestExpense",
  },
  { field: "grossProfit", tags: ["GrossProfit"], units: ["USD"], periodType: "duration" },
  { field: "operatingExpense", tags: ["OperatingExpenses"], units: ["USD"], periodType: "duration" },
  { field: "operatingIncome", tags: ["OperatingIncomeLoss"], units: ["USD"], periodType: "duration" },
  { field: "netIncome", tags: ["NetIncomeLoss"], units: ["USD"], periodType: "duration" },
  { field: "netIncomeIncludingNoncontrollingInterests", tags: ["ProfitLoss"], units: ["USD"], periodType: "duration" },
  { field: "netIncomeCommonStockholders", tags: ["NetIncomeLossAvailableToCommonStockholdersBasic"], units: ["USD"], periodType: "duration" },
  {
    field: "operatingCashFlow",
    tags: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    units: ["USD"],
    periodType: "duration",
  },
  {
    field: "capitalExpenditure",
    tags: ["PaymentsToAcquirePropertyPlantAndEquipment"],
    units: ["USD"],
    periodType: "duration",
    transform: (value) => -Math.abs(value),
  },
  { field: "totalAssets", tags: ["Assets"], units: ["USD"], periodType: "instant" },
  {
    field: "totalEquity",
    tags: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    units: ["USD"],
    periodType: "instant",
  },
  { field: "eps", tags: ["EarningsPerShareDiluted"], units: ["USD/shares"], periodType: "duration" },
  { field: "basicShares", tags: ["WeightedAverageNumberOfSharesOutstandingBasic"], units: ["shares"], periodType: "duration" },
  { field: "dilutedShares", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"], units: ["shares"], periodType: "duration" },
];

/** Lines whose fiscal fourth quarter is checked: a statement field's facts, or tags read only for the check. */
const FOURTH_QUARTER_LINES: Array<{ fields: StatementGapField[]; source: keyof FinancialStatement | string[] }> = [
  { fields: ["totalRevenue", "operatingRevenue"], source: "totalRevenue" },
  { fields: ["netIncome"], source: "netIncome" },
  { fields: ["netIncomeIncludingNoncontrollingInterests"], source: "netIncomeIncludingNoncontrollingInterests" },
  { fields: ["netIncomeCommonStockholders"], source: "netIncomeCommonStockholders" },
  { fields: ["pretaxIncome"], source: [
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  ] },
  { fields: ["taxProvision"], source: ["IncomeTaxExpenseBenefit"] },
];

function normalize(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

function zeroPadCik(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(10, "0");
}

function parseDate(value: unknown): Date | undefined {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  return new Date(`${text}T00:00:00Z`);
}

function stripAccessionDashes(accessionNumber: string): string {
  return accessionNumber.replace(/-/g, "");
}

function documentNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return url.split("/").pop() ?? url;
  }
}

function normalizeDocumentName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function cleanSecTableText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function resolveSecArchiveUrl(href: string, filingUrl: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, filingUrl);
    const ixviewerDocument = url.searchParams.get("doc");
    if (ixviewerDocument?.startsWith("/Archives/")) {
      return new URL(ixviewerDocument, "https://www.sec.gov").toString();
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isHtmlResponse(body: string): boolean {
  return /^\s*<!DOCTYPE html/i.test(body) || /^\s*<html/i.test(body);
}

function isSecBlockMessage(body: string): boolean {
  return /Undeclared Automated Tool|Request Rate Threshold Exceeded/i.test(body);
}

export function parseTickerLookup(payload: unknown): Map<string, LookupEntry> {
  const results = new Map<string, LookupEntry>();
  const record = recordOrNull(payload);
  if (!record) return results;

  const fields = Array.isArray(record.fields)
    ? record.fields.map((field) => String(field))
    : null;
  const data = Array.isArray(record.data) ? record.data : null;

  if (fields && data) {
    const cikIndex = fields.findIndex((field) => normalize(field) === "CIK");
    const tickerIndex = fields.findIndex((field) => normalize(field) === "TICKER");
    const exchangeIndex = fields.findIndex((field) => normalize(field) === "EXCHANGE");
    const nameIndex = fields.findIndex((field) => normalize(field) === "NAME");

    for (const row of data) {
      if (!Array.isArray(row)) continue;
      const ticker = normalize(String(row[tickerIndex] ?? ""));
      const cik = zeroPadCik(row[cikIndex]);
      if (!ticker || !cik) continue;
      results.set(ticker, {
        cik,
        exchange: typeof row[exchangeIndex] === "string" ? row[exchangeIndex] as string : undefined,
        name: typeof row[nameIndex] === "string" ? row[nameIndex] as string : undefined,
      });
    }
    if (results.size > 0) return results;
  }

  for (const value of Object.values(record)) {
    const entry = recordOrNull(value);
    if (!entry) continue;
    const ticker = normalize(String(entry.ticker ?? entry.symbol ?? ""));
    const cik = zeroPadCik(entry.cik ?? entry.cik_str);
    if (!ticker || !cik) continue;
    results.set(ticker, {
      cik,
      exchange: typeof entry.exchange === "string" ? entry.exchange : undefined,
      name: typeof entry.title === "string"
        ? entry.title
        : typeof entry.name === "string"
          ? entry.name
          : undefined,
    });
  }

  return results;
}

export function parseSubmissionArchiveNames(payload: unknown): string[] {
  const files = recordOrNull(recordOrNull(payload)?.filings)?.files;
  if (!Array.isArray(files)) return [];
  const names: string[] = [];
  for (const file of files) {
    const name = recordOrNull(file)?.name;
    if (typeof name === "string" && /^CIK\d+-submissions-\d+\.json$/i.test(name)) {
      names.push(name);
    }
  }
  return names;
}

function parseFilingColumns(
  columns: Record<string, unknown> | null | undefined,
  company: { cik: string; displayCik: string; companyName?: string },
  limit: number,
): SecFilingItem[] {
  if (!columns || !company.displayCik) return [];
  const accessionNumbers = Array.isArray(columns.accessionNumber) ? columns.accessionNumber : [];
  const forms = Array.isArray(columns.form) ? columns.form : [];
  const filingDates = Array.isArray(columns.filingDate) ? columns.filingDate : [];
  const acceptanceTimes = Array.isArray(columns.acceptanceDateTime) ? columns.acceptanceDateTime : [];
  const primaryDocuments = Array.isArray(columns.primaryDocument) ? columns.primaryDocument : [];
  const primaryDescriptions = Array.isArray(columns.primaryDocDescription) ? columns.primaryDocDescription : [];
  const items = Array.isArray(columns.items) ? columns.items : [];
  const total = Math.min(
    Math.max(accessionNumbers.length, forms.length, filingDates.length),
    Math.max(limit, 0),
  );

  const results: SecFilingItem[] = [];
  for (let index = 0; index < total; index += 1) {
    const accessionNumber = String(accessionNumbers[index] ?? "").trim();
    const form = String(forms[index] ?? "").trim();
    const filingDate = parseDate(filingDates[index]);
    if (!accessionNumber || !form || !filingDate) continue;

    const accessionNumberNoDashes = stripAccessionDashes(accessionNumber);
    const primaryDocument = String(primaryDocuments[index] ?? "").trim() || undefined;
    const filingUrl = `https://www.sec.gov/Archives/edgar/data/${company.displayCik}/${accessionNumber}-index.htm`;
    const primaryDocumentUrl = primaryDocument
      ? `https://www.sec.gov/Archives/edgar/data/${company.displayCik}/${accessionNumberNoDashes}/${primaryDocument}`
      : undefined;

    results.push({
      accessionNumber,
      form,
      filingDate,
      acceptedAt: parseSecAcceptanceTime(acceptanceTimes[index]),
      acceptedAtRaw: typeof acceptanceTimes[index] === "string" ? acceptanceTimes[index].trim() || undefined : undefined,
      primaryDocument,
      primaryDocDescription: String(primaryDescriptions[index] ?? "").trim() || undefined,
      items: String(items[index] ?? "").trim() || undefined,
      cik: company.cik,
      companyName: company.companyName,
      filingUrl,
      primaryDocumentUrl,
    });
  }

  return results;
}

function submissionCompany(payload: unknown, fallbackCik = ""): {
  cik: string;
  displayCik: string;
  companyName?: string;
} {
  const record = recordOrNull(payload);
  const cik = zeroPadCik(record?.cik) ?? fallbackCik;
  return {
    cik,
    displayCik: String(Number(cik || "0")),
    companyName: typeof record?.name === "string" ? record.name : undefined,
  };
}

export function parseRecentFilings(payload: unknown, count = 15): SecFilingItem[] {
  const record = recordOrNull(payload);
  if (!record) return [];
  const recent = recordOrNull(recordOrNull(record.filings)?.recent)
    ?? (Array.isArray(record.accessionNumber) ? record : null);
  return parseFilingColumns(recent, submissionCompany(record), count);
}

export function parseFilingDocuments(indexHtml: string, filing: SecFilingItem): SecFilingDocument[] {
  const documents: SecFilingDocument[] = [];
  const primaryUrl = normalizeDocumentName(filing.primaryDocumentUrl);
  const primaryDocument = normalizeDocumentName(filing.primaryDocument);
  const rows = [...indexHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const rowMatch of rows) {
    const rowHtml = rowMatch[1] ?? "";
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1] ?? "");
    if (cells.length < 3) continue;

    const hrefMatch = rowHtml.match(/<a\b[^>]*href="([^"]+)"[^>]*>/i);
    if (!hrefMatch?.[1]) continue;
    const url = resolveSecArchiveUrl(hrefMatch[1], filing.filingUrl);
    if (!url || !url.includes("/Archives/edgar/data/")) continue;

    const sequence = cleanSecTableText(cells[0] ?? "") || undefined;
    const description = cleanSecTableText(cells[1] ?? "") || undefined;
    const linkedDocument = cleanSecTableText(cells[2] ?? "") || documentNameFromUrl(url);
    const type = cleanSecTableText(cells[3] ?? "") || linkedDocument;
    const size = cleanSecTableText(cells[4] ?? "") || undefined;
    const document = linkedDocument || documentNameFromUrl(url);
    const normalizedDocument = normalizeDocumentName(document);
    const normalizedUrl = normalizeDocumentName(url);

    documents.push({
      sequence,
      type,
      description,
      document,
      url,
      size,
      isPrimary: (
        (primaryDocument.length > 0 && normalizedDocument === primaryDocument)
        || (primaryUrl.length > 0 && normalizedUrl === primaryUrl)
        || (
          documents.length === 0
          && normalizeDocumentName(type) === normalizeDocumentName(filing.form)
        )
      ),
    });
  }

  return documents;
}

function companyFactsEntries(payload: unknown, tag: string, units: string[]): CompanyFactsEntry[] {
  const facts = recordOrNull(recordOrNull(recordOrNull(payload)?.facts)?.["us-gaap"]);
  const fact = recordOrNull(facts?.[tag]);
  const unitRecord = recordOrNull(fact?.units);
  if (!unitRecord) return [];

  for (const unit of units) {
    const entries = unitRecord[unit];
    if (!Array.isArray(entries)) continue;
    return entries
      .map((entry) => recordOrNull(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map((entry) => ({
        accn: typeof entry.accn === "string" ? entry.accn : undefined,
        start: typeof entry.start === "string" ? entry.start : undefined,
        end: typeof entry.end === "string" ? entry.end : undefined,
        val: typeof entry.val === "number" ? entry.val : undefined,
        fy: typeof entry.fy === "number" ? entry.fy : null,
        fp: typeof entry.fp === "string" ? entry.fp : null,
        form: typeof entry.form === "string" ? entry.form : undefined,
        filed: typeof entry.filed === "string" ? entry.filed : undefined,
        frame: typeof entry.frame === "string" ? entry.frame : undefined,
      }))
      .filter((entry) => (
        typeof entry.val === "number"
        && Number.isFinite(entry.val)
        && typeof entry.end === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(entry.end)
      ));
  }

  return [];
}

/**
 * SEC frames one fact per span, the latest filed: a 10-K's own fourth quarter
 * is framed only on the next 10-K that repeats it. An earlier fact reporting
 * the framed figure for that span is that quarter too, so it keeps its date.
 */
function withFramedQuarters(entries: CompanyFactsEntry[], sameFigure?: SameFigure): CompanyFactsEntry[] {
  const span = (entry: CompanyFactsEntry) => `${entry.start}:${entry.end}`;
  const framed = new Map<string, CompanyFactsEntry[]>();
  for (const entry of entries) {
    if (!entry.start || !/^CY\d{4}Q[1-4]$/.test(entry.frame ?? "")) continue;
    framed.set(span(entry), [...framed.get(span(entry)) ?? [], entry]);
  }
  if (!framed.size) return entries;
  return entries.map((entry) => entry.start && framed.get(span(entry))?.some((quarter) =>
    Object.is(quarter.val, entry.val) || sameFigure?.(entry, quarter)) ? { ...entry, framedQuarter: true } : entry);
}

function secFormRank(form: string | undefined): number {
  const normalized = normalize(form);
  if (normalized === "10-K/A") return 4;
  if (normalized === "10-K") return 3;
  if (normalized === "10-Q/A") return 2;
  if (normalized === "10-Q") return 1;
  return 0;
}

function companyFactsFiledRank(value: string | undefined): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 0;
  return Date.parse(`${value}T00:00:00Z`) || 0;
}

function shouldReplaceCompanyFact(
  candidate: CompanyFactsEntry,
  selected: CompanyFactsEntry | undefined,
  repeats?: SameFigure,
): boolean {
  if (!selected) return true;
  const left = candidate;
  const right = selected;
  // Ordered tags are fallback concepts, not interchangeable restatements.
  // For example ProfitLoss includes noncontrolling interests while the
  // preferred NetIncomeLoss reports income attributable to the parent.
  const priorityDiff = (left.tagPriority ?? 0) - (right.tagPriority ?? 0);
  if (priorityDiff !== 0) return priorityDiff < 0;
  const leftFiled = companyFactsFiledRank(left.filed);
  const rightFiled = companyFactsFiledRank(right.filed);
  const filedDiff = leftFiled - rightFiled;
  if (filedDiff !== 0) {
    if (leftFiled === 0) return false;
    if (rightFiled === 0) return true;
    if (filedDiff < 0) return false;
    // Later comparative repeats do not move the original disclosure date.
    // A later value change is a restatement and replaces the selected fact.
    return !Object.is(left.val, right.val) && !repeats?.(left, right);
  }
  const formDiff = secFormRank(left.form) - secFormRank(right.form);
  if (formDiff !== 0) return formDiff > 0;
  return String(left.frame ?? "").localeCompare(String(right.frame ?? "")) > 0;
}

/** Whether two facts for one span report the same figure under different values. */
type SameFigure = (left: CompanyFactsEntry, right: CompanyFactsEntry) => boolean;

/**
 * A split re-expresses EPS on the new share count: two values are one figure
 * when the share-basis evidence puts them on different bases and they agree
 * on the current one within each filing's cent rounding.
 */
function splitEquivalent(resolveEps: ReturnType<typeof createSecEpsBasisResolver>): SameFigure {
  return (left, right) => {
    const [a, b] = [resolveEps(left), resolveEps(right)];
    return a.basis?.status === "split-adjusted" && b.basis?.status === "split-adjusted" && a.basis.factor !== b.basis.factor
      && a.value !== undefined && b.value !== undefined
      && Math.abs(a.value - b.value) <= .005 / a.basis.factor! + .005 / b.basis.factor! + 1e-12;
  };
}

/**
 * A later split re-expression of the selected EPS, or a later repeat of one,
 * is a comparative repeat and not a restatement. The original disclosure
 * stays selected and dated; the resolver carries it to the current basis.
 */
function splitRepeats(sameFigure: SameFigure): SameFigure {
  const repeated = new WeakMap<CompanyFactsEntry, Set<number>>();
  return (candidate, selected) => {
    if (repeated.get(selected)?.has(candidate.val!)) return true;
    if (!sameFigure(candidate, selected)) return false;
    repeated.set(selected, (repeated.get(selected) ?? new Set()).add(candidate.val!));
    return true;
  };
}

function compareCompanyFactsChronologically(
  left: CompanyFactsEntry,
  right: CompanyFactsEntry,
): number {
  return companyFactsFiledRank(left.filed) - companyFactsFiledRank(right.filed)
    || secFormRank(left.form) - secFormRank(right.form)
    || String(left.frame ?? "").localeCompare(String(right.frame ?? ""));
}

function isAnnualFiling(entry: CompanyFactsEntry): boolean {
  const form = normalize(entry.form);
  return form === "10-K" || form === "10-K/A";
}

function isAnnualDurationFact(entry: CompanyFactsEntry): boolean {
  if (!isAnnualFiling(entry)) return false;
  const start = entry.start ? Date.parse(`${entry.start}T00:00:00Z`) : Number.NaN;
  const end = entry.end ? Date.parse(`${entry.end}T00:00:00Z`) : Number.NaN;
  const days = (end - start) / 86_400_000;
  // `fp` describes the filing, not each fact in it. A 10-K also repeats
  // quarterly results. SEC annual frames allow 365 +/- 30 days, including
  // 52/53-week fiscal years; shorter transition periods remain unclassified.
  return Number.isFinite(days) && days >= 335 && days <= 395;
}

function isQuarterlyCompanyFact(entry: CompanyFactsEntry, periodType: "duration" | "instant"): boolean {
  if (!/^(10-K|10-Q)(\/A)?$/.test(normalize(entry.form))) return false;
  if (periodType === "instant") {
    return /^CY\d{4}Q[1-4]I$/.test(entry.frame ?? "")
      || (
        (normalize(entry.form) === "10-Q" || normalize(entry.form) === "10-Q/A")
        && /^Q[1-3]$/.test(normalize(entry.fp ?? undefined))
      );
  }
  if (entry.concept === "RevenuesNetOfInterestExpense") {
    // A quarterly frame cannot turn bank revenue reported year-to-date into
    // a direct quarter. Keep the source's net-of-interest amount unchanged.
    const start = Date.parse(`${entry.start}T00:00:00Z`);
    const end = Date.parse(`${entry.end}T00:00:00Z`);
    const days = (end - start) / 86_400_000;
    if (!Number.isFinite(days) || days < 60 || days > 120
      || new Date(start).toISOString().slice(0, 10) !== entry.start
      || new Date(end).toISOString().slice(0, 10) !== entry.end) return false;
  }
  if (/^CY\d{4}Q[1-4]$/.test(entry.frame ?? "") || entry.framedQuarter) return true;
  const form = normalize(entry.form);
  const fiscalPeriod = normalize(entry.fp ?? undefined);
  if ((form !== "10-Q" && form !== "10-Q/A") || !/^Q[1-3]$/.test(fiscalPeriod)) return false;
  const start = entry.start ? Date.parse(`${entry.start}T00:00:00Z`) : Number.NaN;
  const end = entry.end ? Date.parse(`${entry.end}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  const durationDays = (end - start) / (24 * 60 * 60 * 1_000);
  // SEC often omits `frame` from the original issuer-quarter fact while later
  // comparative filings add it. Duration distinguishes the single quarter
  // from six- or nine-month year-to-date facts in the same 10-Q.
  return durationDays >= 60 && durationDays <= 120;
}

function setCompanyFactValue(
  rows: Map<string, FinancialStatement>,
  selectedFacts: Map<string, CompanyFactsEntry>,
  date: string,
  field: keyof FinancialStatement,
  value: number,
  entry: CompanyFactsEntry,
  repeats?: SameFigure,
): void {
  const selectionKey = `${date}:${String(field)}`;
  if (!shouldReplaceCompanyFact(entry, selectedFacts.get(selectionKey), repeats)) return;
  const row = rows.get(date) ?? { date, dateSource: "sec", currency: "USD" };
  (row as unknown as Record<string, unknown>)[field] = value;
  if (entry.filed) {
    row.fieldAvailability = {
      ...(row.fieldAvailability ?? {}),
      [String(field)]: entry.filed,
    };
  } else if (row.fieldAvailability) {
    delete row.fieldAvailability[String(field)];
    if (Object.keys(row.fieldAvailability).length === 0) delete row.fieldAvailability;
  }
  row.availableAt = Object.values(row.fieldAvailability ?? {}).sort().at(-1);
  if (!row.availableAt) delete row.availableAt;
  rows.set(date, row);
  selectedFacts.set(selectionKey, entry);
}

function fillCompanyFactsStatementRows(
  rows: Map<string, FinancialStatement>,
  selectedFacts: Map<string, CompanyFactsEntry>,
  entries: CompanyFactsEntry[],
  field: CompanyFactsStatementField,
  period: "annual" | "quarterly",
  annualPeriodEnds: ReadonlySet<string>,
  repeats?: SameFigure,
): void {
  for (const entry of [...entries].sort(compareCompanyFactsChronologically)) {
    if (!entry.end || typeof entry.val !== "number") continue;
    const matchesPeriod = period === "annual"
      ? field.periodType === "duration"
        ? isAnnualDurationFact(entry)
        : isAnnualFiling(entry) && annualPeriodEnds.has(entry.end)
      : isQuarterlyCompanyFact(entry, field.periodType);
    if (!matchesPeriod) continue;
    setCompanyFactValue(
      rows,
      selectedFacts,
      entry.end,
      field.field,
      field.transform ? field.transform(entry.val) : entry.val,
      entry,
      repeats,
    );
  }
}

function finalizeCompanyFactsStatements(rows: Map<string, FinancialStatement>, selectedFacts: Map<string, CompanyFactsEntry>, resolveEps: ReturnType<typeof createSecEpsBasisResolver>): FinancialStatement[] {
  const statements = Array.from(rows.values()).sort((left, right) => left.date.localeCompare(right.date));
  for (const statement of statements) {
    const bases: Record<string, IncomeStatementSource["basis"]> = {
      netIncome: "parent", netIncomeIncludingNoncontrollingInterests: "consolidated", netIncomeCommonStockholders: "common",
    };
    for (const field of INCOME_STATEMENT_FIELDS) {
      const fact = selectedFacts.get(`${statement.date}:${field}`);
      if (!fact?.concept) continue;
      statement.fieldSources ??= {};
      statement.fieldSources[field] = {
        source: "sec", concept: fact.concept, basis: bases[field]!, unit: "USD", endDate: fact.end!,
        ...(fact.accn ? { accessionNumber: fact.accn } : {}),
        ...(fact.filed ? { filed: fact.filed } : {}),
        ...(fact.start ? { startDate: fact.start } : {}),
      };
    }
    if (statement.fieldSources) {
      const missing = INCOME_STATEMENT_FIELDS.filter(field => !statement.fieldSources?.[field]);
      if (missing.length) statement.unavailableFields = missing;
    }
    for (const field of ["basicShares", "dilutedShares"] as const) {
      const fact = selectedFacts.get(`${statement.date}:${field}`);
      if (!fact) continue;
      // Use the accession's proved basis, never the EPS-specific numeric result:
      // reported share counts cannot be divided or multiplied as EPS values.
      const { basis, availableAt } = resolveEps(fact);
      if (basis && (basis.status !== "split-adjusted" || basis.factor !== 1)) {
        delete statement[field];
        if (statement.fieldAvailability) delete statement.fieldAvailability[field];
      } else if (basis && availableAt) {
        statement.fieldAvailability = { ...statement.fieldAvailability, [field]: availableAt };
      }
    }
    const epsFact = selectedFacts.get(`${statement.date}:eps`);
    if (epsFact) {
      const normalized = resolveEps(epsFact);
      if (normalized.basis) {
        statement.epsBasis = normalized.basis;
        statement.eps = normalized.value;
        if (normalized.availableAt) statement.fieldAvailability!.eps = normalized.availableAt;
        else if (statement.fieldAvailability) delete statement.fieldAvailability.eps;
      }
    }
    // A selected duration fact identifies the fiscal period. Its accession and
    // filing date are evidence for that identity, never row-wide availability.
    const anchor = [...selectedFacts.entries()]
      .filter(([key, entry]) => key.startsWith(`${statement.date}:`) && entry.start && entry.accn
        && /^\d{10}-\d{2}-\d{6}$/.test(entry.accn) && entry.filed && entry.filed >= statement.date)
      .map(([, entry]) => entry)
      .sort((left, right) => left.filed!.localeCompare(right.filed!) || left.accn!.localeCompare(right.accn!))[0];
    if (anchor) statement.dateEvidence = { accessionNumber: anchor.accn!, filed: anchor.filed!, startDate: anchor.start! };
    if (
      typeof statement.freeCashFlow !== "number"
      && typeof statement.operatingCashFlow === "number"
      && typeof statement.capitalExpenditure === "number"
    ) {
      statement.freeCashFlow = statement.operatingCashFlow + statement.capitalExpenditure;
      const operatingCashFlowAvailableAt = statement.fieldAvailability?.operatingCashFlow;
      const capitalExpenditureAvailableAt = statement.fieldAvailability?.capitalExpenditure;
      const derivedAvailableAt = operatingCashFlowAvailableAt && capitalExpenditureAvailableAt
        ? [operatingCashFlowAvailableAt, capitalExpenditureAvailableAt].sort().at(-1) : undefined;
      if (derivedAvailableAt) {
        statement.fieldAvailability = {
          ...(statement.fieldAvailability ?? {}),
          freeCashFlow: derivedAvailableAt,
        };
      }
    }
    const numericFields = Object.keys(statement).filter((field) => typeof (statement as unknown as Record<string, unknown>)[field] === "number");
    statement.fieldAvailability ??= {};
    statement.availableAt = numericFields.every((field) => statement.fieldAvailability?.[field])
      ? Object.values(statement.fieldAvailability).sort().at(-1) : undefined;
  }
  return statements;
}

// Filling gaps per period from a concept with another definition mixes two
// measures in one series (AXP fee revenue next to total net revenue). A filing
// that reports both for one period with different values proves they differ.
function withoutDifferentMeasureFallback(field: CompanyFactsStatementField, entries: CompanyFactsEntry[]): CompanyFactsEntry[] {
  const fallback = field.sameMeasureFallback;
  if (!fallback) return entries;
  const periodKey = (entry: CompanyFactsEntry) => `${entry.accn}:${entry.start}:${entry.end}`;
  const fallbackValues = new Map(entries.filter((entry) => entry.concept === fallback)
    .map((entry) => [periodKey(entry), entry.val]));
  const differs = entries.some((entry) => entry.concept !== fallback
    && fallbackValues.has(periodKey(entry)) && fallbackValues.get(periodKey(entry)) !== entry.val);
  return differs ? entries.filter((entry) => entry.concept !== fallback) : entries;
}

export function parseCompanyFactsFinancialStatements(payload: unknown): SecCompanyFactsStatements {
  const annualRows = new Map<string, FinancialStatement>();
  const quarterlyRows = new Map<string, FinancialStatement>();
  const annualSelectedFacts = new Map<string, CompanyFactsEntry>();
  const quarterlySelectedFacts = new Map<string, CompanyFactsEntry>();
  const resolveEps = createSecEpsBasisResolver(payload);
  // Diluted EPS only: share counts are kept only on the current basis.
  const sameEps = splitEquivalent(resolveEps);
  const fieldEntries = COMPANY_FACTS_STATEMENT_FIELDS.map((field) => ({
    field,
    entries: withoutDifferentMeasureFallback(field, field.tags.flatMap((tag, tagPriority) => withFramedQuarters(
      companyFactsEntries(payload, tag, field.units), field.field === "eps" ? sameEps : undefined,
    ).map((entry) => ({ ...entry, tagPriority, concept: tag })))),
  }));
  // Balance-sheet facts have no duration. Anchor their dates to actual annual
  // periods, so quarterly comparative snapshots in a 10-K stay quarterly.
  const annualPeriodEnds = new Set(fieldEntries.flatMap(({ field, entries }) => field.periodType === "duration"
    ? entries.filter(isAnnualDurationFact).map((entry) => entry.end!)
    : []));

  const epsRepeats = splitRepeats(sameEps);
  for (const { field, entries } of fieldEntries) {
    if (entries.length === 0) continue;
    const repeats = field.field === "eps" ? epsRepeats : undefined;
    fillCompanyFactsStatementRows(annualRows, annualSelectedFacts, entries, field, "annual", annualPeriodEnds, repeats);
    fillCompanyFactsStatementRows(quarterlyRows, quarterlySelectedFacts, entries, field, "quarterly", annualPeriodEnds, repeats);
  }

  const fourthQuarters = FOURTH_QUARTER_LINES.flatMap(({ fields, source }) => secFourthQuarters(fields, typeof source === "string"
    ? fieldEntries.find(({ field }) => field.field === source)?.entries ?? []
    : source.flatMap((tag, tagPriority) => companyFactsEntries(payload, tag, ["USD"]).map((entry) => ({ ...entry, tagPriority, concept: tag })))));
  return {
    annualStatements: finalizeCompanyFactsStatements(annualRows, annualSelectedFacts, resolveEps),
    quarterlyStatements: withGuardedFourthQuarters(finalizeCompanyFactsStatements(quarterlyRows, quarterlySelectedFacts, resolveEps), fourthQuarters),
    fourthQuarters,
  };
}

export class SecEdgarClient {
  private lookupPromise: Promise<Map<string, LookupEntry>> | null = null;

  private defaultHeaders() {
    return {
      "User-Agent": DEFAULT_SEC_USER_AGENT,
      From: DEFAULT_SEC_FROM,
      Accept: "application/json,text/plain,*/*",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.sec.gov/",
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const { body } = await this.fetchText(url);
    if (isHtmlResponse(body)) throw new Error("SEC returned HTML instead of JSON.");
    return JSON.parse(body) as T;
  }

  private async fetchText(url: string): Promise<{ body: string; contentType: string }> {
    const response = await fetch(url, {
      headers: this.defaultHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await response.text();

    if (isSecBlockMessage(body)) {
      throw new Error("SEC blocked the request. Try setting SEC_USER_AGENT to 'MyApp AdminContact@example.com'.");
    }
    if (!response.ok) {
      throw new Error(`SEC request failed (${response.status}): ${truncateWithEllipsis(body.trim(), 160)}`);
    }

    return {
      body,
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  private extractArchiveLinks(indexHtml: string): string[] {
    const matches = [...indexHtml.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)];
    const urls = matches
      .map((match) => match[1] ?? "")
      .map((href) => {
        if (/^https?:\/\//i.test(href)) return href;
        if (href.startsWith("/Archives/")) return `https://www.sec.gov${href}`;
        return null;
      })
      .filter((value): value is string => !!value && value.includes("/Archives/edgar/data/"));

    return [...new Set(urls)];
  }

  private async findAlternativeHtmlDocumentUrl(filingUrl: string, currentUrl?: string): Promise<string | null> {
    const { body } = await this.fetchText(filingUrl);
    const links = this.extractArchiveLinks(body);
    return links.find((url) => (
      url !== currentUrl
      && !/-index\.htm(?:$|[?#])/i.test(url)
      && /\.(?:html?|xhtml)(?:$|[?#])/i.test(url)
    )) ?? null;
  }

  private async loadLookup(): Promise<Map<string, LookupEntry>> {
    if (!this.lookupPromise) {
      this.lookupPromise = this.fetchJson<unknown>(LOOKUP_URL)
        .then((payload) => parseTickerLookup(payload))
        .catch((error) => {
          this.lookupPromise = null;
          throw error;
        });
    }
    return this.lookupPromise;
  }

  async getRecentFilings(ticker: string, count = 15): Promise<SecFilingItem[]> {
    const normalizedTicker = normalize(ticker);
    if (!normalizedTicker) return [];

    const lookup = await this.loadLookup();
    const entry = lookup.get(normalizedTicker);
    if (!entry) return [];

    const payload = await this.fetchJson<unknown>(`${SUBMISSIONS_URL}/CIK${entry.cik}.json`);
    const filings = parseRecentFilings(payload, count);
    if (filings.length >= count) return filings;
    const company = submissionCompany(payload, entry.cik);
    for (const name of parseSubmissionArchiveNames(payload)) {
      if (filings.length >= count) break;
      const older = await this.fetchJson<unknown>(`${SUBMISSIONS_URL}/${name}`);
      filings.push(...parseFilingColumns(recordOrNull(older), company, count - filings.length));
    }
    return filings;
  }

  async getFinancialStatements(ticker: string): Promise<SecCompanyFactsStatements | null> {
    const normalizedTicker = normalize(ticker);
    if (!normalizedTicker) return null;

    const lookup = await this.loadLookup();
    const entry = lookup.get(normalizedTicker) ?? lookup.get(normalizedTicker.replace(/\./g, "-"));
    if (!entry) return null;

    const payload = await this.fetchJson<unknown>(`${COMPANY_FACTS_URL}/CIK${entry.cik}.json`);
    if (zeroPadCik(recordOrNull(payload)?.cik) !== entry.cik) throw new Error("SEC companyfacts issuer mismatch");
    const statements = parseCompanyFactsFinancialStatements(payload);
    if (/[.-]/.test(normalizedTicker)) {
      for (const row of [...statements.annualStatements, ...statements.quarterlyStatements]) {
        for (const field of ["eps", "basicShares", "dilutedShares"] as const) {
          delete row[field];
          if (row.fieldAvailability) delete row.fieldAvailability[field];
        }
      }
    }
    return statements;
  }

  async getFilingDocuments(filing: SecFilingItem): Promise<SecFilingDocument[]> {
    const { body } = await this.fetchText(filing.filingUrl);
    return parseFilingDocuments(body, filing);
  }

  async getFilingContent(filing: Pick<SecFilingItem, "primaryDocumentUrl" | "filingUrl" | "form">): Promise<string | null> {
    let targetUrl = filing.primaryDocumentUrl || filing.filingUrl;
    if (!targetUrl) return null;

    // SEC ownership forms (3/4/5) have XSL-prefixed primaryDocument paths
    // (e.g., "xslF345X06/wk-form4_xxx.xml") which return rendered HTML.
    // Strip the prefix and return the raw XML for programmatic parsing.
    const ownershipForm = !!filing.form && /^[345](?:\/A)?$/i.test(filing.form.trim());
    if (filing.primaryDocumentUrl && ownershipForm) {
      targetUrl = filing.primaryDocumentUrl.replace(/\/xsl[^/]+\//, "/");
    }

    if (filing.primaryDocumentUrl && isPdfDocument("", "", filing.primaryDocumentUrl)) {
      if (filing.filingUrl === filing.primaryDocumentUrl) {
        return PDF_FALLBACK_MESSAGE;
      }
      const alternativeUrl = filing.filingUrl
        ? await this.findAlternativeHtmlDocumentUrl(filing.filingUrl, filing.primaryDocumentUrl)
        : null;
      if (!alternativeUrl) return PDF_FALLBACK_MESSAGE;

      const { body, contentType } = await this.fetchText(alternativeUrl);
      return extractFilingContent(body, contentType, { form: filing.form, sourceUrl: alternativeUrl });
    }

    const { body, contentType } = await this.fetchText(targetUrl);
    if (ownershipForm && /<(?:[\w.-]+:)?ownershipDocument(?:\s|>)/i.test(body)
      && !isPdfDocument(body, contentType, targetUrl)) return body;
    return extractFilingContent(body, contentType, { form: filing.form, sourceUrl: targetUrl });
  }
}
