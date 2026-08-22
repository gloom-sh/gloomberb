import type { SecFilingDocument, SecFilingItem } from "../types/data-provider";
import type { FinancialStatement } from "../types/financials";
import { truncateWithEllipsis } from "../utils/text-wrap";
import { decodeHtmlEntities } from "../utils/html-entities";
import {
  PDF_FALLBACK_MESSAGE,
  extractFilingContent,
  isPdfDocument,
} from "./sec-edgar/content";

export { extractFilingContent } from "./sec-edgar/content";

const LOOKUP_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts";
const FETCH_TIMEOUT_MS = 15_000;

function sanitizeIdentityPart(value: string, fallback: string): string {
  const sanitized = value.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function extractEmail(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] ?? null;
}

function getEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

function getRuntimeHostName(): string {
  const maybeLocation = (globalThis as { location?: { hostname?: string } }).location;
  if (maybeLocation?.hostname) {
    return maybeLocation.hostname;
  }
  return "localhost";
}

const runtimeHostName = getRuntimeHostName();

const DEFAULT_SEC_FROM =
  getEnv("SEC_FROM_EMAIL")?.trim()
  || extractEmail(getEnv("SEC_USER_AGENT"))
  || `${sanitizeIdentityPart(getEnv("USER") ?? "gloomberb", "gloomberb")}@${sanitizeIdentityPart(`${runtimeHostName}.local`, "localhost.localdomain")}`;

const DEFAULT_SEC_USER_AGENT =
  getEnv("SEC_USER_AGENT")?.trim()
  || `Gloomberb/0.1 (${sanitizeIdentityPart(runtimeHostName, "localhost")}; contact=${DEFAULT_SEC_FROM})`;

type LookupEntry = {
  cik: string;
  exchange?: string;
  name?: string;
};

type CompanyFactsEntry = {
  start?: string;
  end?: string;
  val?: number;
  fy?: number | null;
  fp?: string | null;
  form?: string;
  filed?: string;
  frame?: string;
};

type CompanyFactsStatementField = {
  field: keyof FinancialStatement;
  tags: string[];
  units: string[];
  periodType: "duration" | "instant";
  transform?: (value: number) => number;
};

export type SecCompanyFactsStatements = {
  annualStatements: FinancialStatement[];
  quarterlyStatements: FinancialStatement[];
};

const COMPANY_FACTS_STATEMENT_FIELDS: CompanyFactsStatementField[] = [
  {
    field: "totalRevenue",
    tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    units: ["USD"],
    periodType: "duration",
  },
  { field: "grossProfit", tags: ["GrossProfit"], units: ["USD"], periodType: "duration" },
  { field: "operatingIncome", tags: ["OperatingIncomeLoss"], units: ["USD"], periodType: "duration" },
  { field: "netIncome", tags: ["NetIncomeLoss", "ProfitLoss"], units: ["USD"], periodType: "duration" },
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
];

function normalize(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

function zeroPadCik(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(10, "0");
}

function parseTimestamp(value: unknown): Date | undefined {
  const digits = String(value ?? "").trim();
  if (!/^\d{14}$/.test(digits)) return undefined;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseTickerLookup(payload: unknown): Map<string, LookupEntry> {
  const results = new Map<string, LookupEntry>();
  const record = asRecord(payload);
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
    const entry = asRecord(value);
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
  const files = asRecord(asRecord(payload)?.filings)?.files;
  if (!Array.isArray(files)) return [];
  const names: string[] = [];
  for (const file of files) {
    const name = asRecord(file)?.name;
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
      acceptedAt: parseTimestamp(acceptanceTimes[index]),
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
  const record = asRecord(payload);
  const cik = zeroPadCik(record?.cik) ?? fallbackCik;
  return {
    cik,
    displayCik: String(Number(cik || "0")),
    companyName: typeof record?.name === "string" ? record.name : undefined,
  };
}

export function parseRecentFilings(payload: unknown, count = 15): SecFilingItem[] {
  const record = asRecord(payload);
  if (!record) return [];
  const recent = asRecord(asRecord(record.filings)?.recent)
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

function companyFactsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function companyFactsEntries(payload: unknown, tag: string, units: string[]): CompanyFactsEntry[] {
  const facts = companyFactsRecord(companyFactsRecord(companyFactsRecord(payload)?.facts)?.["us-gaap"]);
  const fact = companyFactsRecord(facts?.[tag]);
  const unitRecord = companyFactsRecord(fact?.units);
  if (!unitRecord) return [];

  for (const unit of units) {
    const entries = unitRecord[unit];
    if (!Array.isArray(entries)) continue;
    return entries
      .map((entry) => companyFactsRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map((entry) => ({
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
): boolean {
  if (!selected) return true;
  const left = candidate;
  const right = selected;
  const leftFiled = companyFactsFiledRank(left.filed);
  const rightFiled = companyFactsFiledRank(right.filed);
  const filedDiff = leftFiled - rightFiled;
  if (filedDiff !== 0) {
    if (leftFiled === 0) return false;
    if (rightFiled === 0) return true;
    if (filedDiff < 0) return false;
    // Later comparative repeats do not move the original disclosure date.
    // A later value change is a restatement and replaces the selected fact.
    return !Object.is(left.val, right.val);
  }
  const formDiff = secFormRank(left.form) - secFormRank(right.form);
  if (formDiff !== 0) return formDiff > 0;
  return String(left.frame ?? "").localeCompare(String(right.frame ?? "")) > 0;
}

function compareCompanyFactsChronologically(
  left: CompanyFactsEntry,
  right: CompanyFactsEntry,
): number {
  return companyFactsFiledRank(left.filed) - companyFactsFiledRank(right.filed)
    || secFormRank(left.form) - secFormRank(right.form)
    || String(left.frame ?? "").localeCompare(String(right.frame ?? ""));
}

function isAnnualCompanyFact(entry: CompanyFactsEntry): boolean {
  const form = normalize(entry.form);
  return (form === "10-K" || form === "10-K/A") && normalize(entry.fp ?? undefined) === "FY";
}

function isQuarterlyCompanyFact(entry: CompanyFactsEntry, periodType: "duration" | "instant"): boolean {
  if (periodType === "instant") {
    return /^CY\d{4}Q[1-4]I$/.test(entry.frame ?? "")
      || (
        (normalize(entry.form) === "10-Q" || normalize(entry.form) === "10-Q/A")
        && /^Q[1-3]$/.test(normalize(entry.fp ?? undefined))
      );
  }
  if (/^CY\d{4}Q[1-4]$/.test(entry.frame ?? "")) return true;
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
): void {
  const selectionKey = `${date}:${String(field)}`;
  if (!shouldReplaceCompanyFact(entry, selectedFacts.get(selectionKey))) return;
  const row = rows.get(date) ?? { date };
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
): void {
  for (const entry of [...entries].sort(compareCompanyFactsChronologically)) {
    if (!entry.end || typeof entry.val !== "number") continue;
    const matchesPeriod = period === "annual"
      ? isAnnualCompanyFact(entry)
      : isQuarterlyCompanyFact(entry, field.periodType);
    if (!matchesPeriod) continue;
    setCompanyFactValue(
      rows,
      selectedFacts,
      entry.end,
      field.field,
      field.transform ? field.transform(entry.val) : entry.val,
      entry,
    );
  }
}

function finalizeCompanyFactsStatements(rows: Map<string, FinancialStatement>): FinancialStatement[] {
  const statements = Array.from(rows.values()).sort((left, right) => left.date.localeCompare(right.date));
  for (const statement of statements) {
    if (
      typeof statement.freeCashFlow !== "number"
      && typeof statement.operatingCashFlow === "number"
      && typeof statement.capitalExpenditure === "number"
    ) {
      statement.freeCashFlow = statement.operatingCashFlow + statement.capitalExpenditure;
      const operatingCashFlowAvailableAt = statement.fieldAvailability?.operatingCashFlow;
      const capitalExpenditureAvailableAt = statement.fieldAvailability?.capitalExpenditure;
      const derivedAvailableAt = [operatingCashFlowAvailableAt, capitalExpenditureAvailableAt]
        .filter((value): value is string => !!value)
        .sort()
        .at(-1);
      if (derivedAvailableAt) {
        statement.fieldAvailability = {
          ...(statement.fieldAvailability ?? {}),
          freeCashFlow: derivedAvailableAt,
        };
      }
    }
  }
  return statements;
}

export function parseCompanyFactsFinancialStatements(payload: unknown): SecCompanyFactsStatements {
  const annualRows = new Map<string, FinancialStatement>();
  const quarterlyRows = new Map<string, FinancialStatement>();
  const annualSelectedFacts = new Map<string, CompanyFactsEntry>();
  const quarterlySelectedFacts = new Map<string, CompanyFactsEntry>();

  for (const field of COMPANY_FACTS_STATEMENT_FIELDS) {
    const entries = field.tags.flatMap((tag) => companyFactsEntries(payload, tag, field.units));
    if (entries.length === 0) continue;
    fillCompanyFactsStatementRows(annualRows, annualSelectedFacts, entries, field, "annual");
    fillCompanyFactsStatementRows(quarterlyRows, quarterlySelectedFacts, entries, field, "quarterly");
  }

  return {
    annualStatements: finalizeCompanyFactsStatements(annualRows),
    quarterlyStatements: finalizeCompanyFactsStatements(quarterlyRows),
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
    const response = await fetch(url, {
      headers: this.defaultHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await response.text();

    if (!response.ok) {
      if (isSecBlockMessage(body)) {
        throw new Error("SEC blocked the request. Try setting SEC_USER_AGENT to 'MyApp AdminContact@example.com'.");
      }
      throw new Error(`SEC request failed (${response.status}): ${truncateWithEllipsis(body.trim(), 160)}`);
    }

    if (isHtmlResponse(body)) {
      if (isSecBlockMessage(body)) {
        throw new Error("SEC blocked the request. Try setting SEC_USER_AGENT to 'MyApp AdminContact@example.com'.");
      }
      throw new Error("SEC returned HTML instead of JSON.");
    }

    return JSON.parse(body) as T;
  }

  private async fetchText(url: string): Promise<{ body: string; contentType: string }> {
    const response = await fetch(url, {
      headers: this.defaultHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = await response.text();

    if (!response.ok) {
      if (isSecBlockMessage(body)) {
        throw new Error("SEC blocked the request. Try setting SEC_USER_AGENT to 'MyApp AdminContact@example.com'.");
      }
      throw new Error(`SEC request failed (${response.status}): ${truncateWithEllipsis(body.trim(), 160)}`);
    }

    if (isSecBlockMessage(body)) {
      throw new Error("SEC blocked the request. Try setting SEC_USER_AGENT to 'MyApp AdminContact@example.com'.");
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
      filings.push(...parseFilingColumns(asRecord(older), company, count - filings.length));
    }
    return filings;
  }

  async getFinancialStatements(ticker: string): Promise<SecCompanyFactsStatements | null> {
    const normalizedTicker = normalize(ticker);
    if (!normalizedTicker) return null;

    const lookup = await this.loadLookup();
    const entry = lookup.get(normalizedTicker);
    if (!entry) return null;

    const payload = await this.fetchJson<unknown>(`${COMPANY_FACTS_URL}/CIK${entry.cik}.json`);
    return parseCompanyFactsFinancialStatements(payload);
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
    const ownershipForms = new Set(["3", "4", "5"]);
    if (filing.primaryDocumentUrl && filing.form && ownershipForms.has(filing.form.trim())) {
      const rawUrl = filing.primaryDocumentUrl.replace(/\/xsl[^/]+\//, "/");
      if (rawUrl !== filing.primaryDocumentUrl) {
        const { body } = await this.fetchText(rawUrl);
        return body;
      }
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
    return extractFilingContent(body, contentType, { form: filing.form, sourceUrl: targetUrl });
  }
}
