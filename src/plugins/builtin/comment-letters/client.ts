import { DEFAULT_SEC_FROM, DEFAULT_SEC_USER_AGENT } from "../../../sources/sec-edgar/identity";
import type { SecFilingItem } from "../../../types/data-provider";
import { decodeHtmlEntities } from "../../../utils/html-entities";
import { httpFetch } from "../../../utils/http-transport";
import { createThrottledFetch } from "../../../utils/throttled-fetch";
import type { PageRequest } from "../../../components/paged-rows";
import type {
  CommentLetter,
  CommentLetterIssuer,
  CommentLetterPage,
} from "./types";

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const FETCH_TIMEOUT_MS = 15_000;
/** EDGAR full-text search answers 100 hits a page, whatever size is asked for. */
const EFTS_PAGE_SIZE = 100;
/** And pages no further than its 10,000th hit. */
const EFTS_RESULT_WINDOW = 10_000;
const COMMENT_LETTER_FORMS = ["CORRESP", "UPLOAD"] as const;
const COMMENT_LETTER_FORM_SET = new Set<string>(COMMENT_LETTER_FORMS);

const lettersFetch = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: FETCH_TIMEOUT_MS,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: {
    "User-Agent": DEFAULT_SEC_USER_AGENT,
    From: DEFAULT_SEC_FROM,
    Accept: "application/json",
  },
  transport: (url: string, init?: RequestInit) => httpFetch(url, init),
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const firstString = (value: unknown): string =>
  String((Array.isArray(value) ? value[0] : value) ?? "").trim();

const zeroPadCik = (value: unknown): string | null => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.padStart(10, "0") : null;
};

const parseFileDate = (value: unknown): Date | null => {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

/**
 * EDGAR names a filer "Apple Inc.  (AAPL)  (CIK 0000320193)", with two
 * spaces between the parts and every ticker the filer has, or none.
 */
export function parseFilerName(value: string): { companyName?: string; tickers: string[] } {
  const parts = value.trim().split(/\s{2,}/).filter((part) => !/^\(CIK\s+\d+\)$/i.test(part));
  if (parts.length === 0 || !parts[0]) return { tickers: [] };
  const last = parts[parts.length - 1]!;
  const listed = parts.length > 1 ? /^\((.+)\)$/.exec(last)?.[1] : undefined;
  const tickers = listed?.split(",").map((ticker) => ticker.trim()) ?? [];
  if (tickers.length > 0 && tickers.every((ticker) => TICKER.test(ticker))) {
    return { companyName: parts.slice(0, -1).join(" ") || undefined, tickers };
  }
  return { companyName: parts.join(" "), tickers: [] };
}

const archiveUrl = (cik: string, path: string): string =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${path}`;

function parseHit(row: unknown): CommentLetter | null {
  const hit = asRecord(row);
  const source = asRecord(hit?._source);
  if (!hit || !source) return null;
  const hitId = String(hit._id ?? "").trim();
  const accessionNumber = String(source.adsh ?? hitId.split(":")[0] ?? "").trim();
  const form = firstString(source.form ?? source.root_forms).toUpperCase();
  const filingDate = parseFileDate(source.file_date);
  const cik = zeroPadCik(firstString(source.ciks));
  if (!accessionNumber || !COMMENT_LETTER_FORM_SET.has(form) || !filingDate || !cik) return null;
  const primaryDocument = hitId.includes(":") ? hitId.slice(hitId.indexOf(":") + 1).trim() || undefined : undefined;
  const filer = parseFilerName(firstString(source.display_names));
  return {
    id: accessionNumber,
    accessionNumber,
    form,
    author: form === "UPLOAD" ? "staff" : "company",
    companyName: filer.companyName,
    tickers: filer.tickers,
    cik,
    filingDate,
    filingUrl: archiveUrl(cik, `${accessionNumber}-index.htm`),
    primaryDocument,
    primaryDocumentUrl: primaryDocument
      ? archiveUrl(cik, `${accessionNumber.replace(/-/g, "")}/${primaryDocument}`)
      : undefined,
  };
}

/**
 * One page of full-text search hits as letters. A filing with several
 * documents comes back once per document and is kept once. The search
 * reports at most 10,000 matches ("10,000 or more") and pages no further.
 */
export function parseLetterSearchPage(payload: unknown, offset: number): Omit<CommentLetterPage, "issuer"> {
  const hits = asRecord(asRecord(payload)?.hits);
  const raw = Array.isArray(hits?.hits) ? hits.hits : [];
  const total = asRecord(hits?.total);
  const matched = typeof total?.value === "number" ? total.value : offset + raw.length;
  const moreThanCounted = total?.relation === "gte";
  const rows: CommentLetter[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const letter = parseHit(row);
    if (!letter || seen.has(letter.id)) continue;
    seen.add(letter.id);
    rows.push(letter);
  }
  const nextOffset = offset + raw.length;
  const reachable = Math.min(matched, EFTS_RESULT_WINDOW);
  const hasMore = raw.length > 0 && nextOffset < reachable;
  return {
    rows,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
    windowLimited: !hasMore && nextOffset >= EFTS_RESULT_WINDOW && (moreThanCounted || matched > EFTS_RESULT_WINDOW),
  };
}

export function buildLetterSearchUrl({ query, cik, offset = 0 }: { query?: string; cik?: string; offset?: number }): string {
  const url = new URL(EFTS_URL);
  const text = query?.trim();
  if (text) url.searchParams.set("q", text);
  url.searchParams.set("forms", COMMENT_LETTER_FORMS.join(","));
  url.searchParams.set("dateRange", "all");
  if (cik) url.searchParams.set("ciks", cik);
  if (offset > 0) url.searchParams.set("from", String(Math.min(offset, EFTS_RESULT_WINDOW - EFTS_PAGE_SIZE)));
  return url.toString();
}

/** A query that could be a ticker on its own: AAPL, brk.b, BF-B. */
export function tickerCandidate(query: string): string | null {
  const text = query.trim();
  return /^[A-Za-z]{1,5}(?:[.-][A-Za-z]{1,2})?$/.test(text) ? text.toUpperCase() : null;
}

const sameTicker = (left: string, right: string): boolean =>
  left.replace(/\./g, "-").toUpperCase() === right.replace(/\./g, "-").toUpperCase();

/**
 * The company EDGAR's own company lookup files under exactly this ticker, or
 * null. A name that only contains the word (a trust named after it) is not
 * the company.
 */
export function parseTickerMatch(payload: unknown, ticker: string): CommentLetterIssuer | null {
  const hits = asRecord(asRecord(payload)?.hits);
  const rows = Array.isArray(hits?.hits) ? hits.hits : [];
  for (const row of rows) {
    const hit = asRecord(row);
    const source = asRecord(hit?._source);
    const cik = zeroPadCik(hit?._id);
    if (!source || !cik) continue;
    const tickers = String(source.tickers ?? "").split(/[,\s]+/).filter(Boolean);
    const match = tickers.find((candidate) => sameTicker(candidate, ticker));
    if (!match) continue;
    const entity = String(source.entity ?? "").trim();
    const name = entity.replace(/\s*\([^()]*\)\s*$/, "").trim() || entity || match;
    return { cik, ticker: match.toUpperCase(), name };
  }
  return null;
}

// Topics as words in the letter, not a reading of it: a hit says the text
// uses the term, not that the staff found a problem or how serious it is.
const LETTER_TOPICS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brestat(?:e|ed|ement|ements|ing)\b/i, label: "restatement" },
  { pattern: /\bmaterial\s+weakness/i, label: "material weakness" },
  { pattern: /\bgoing\s+concern\b/i, label: "going concern" },
  { pattern: /\brevenue\s+recognition\b/i, label: "revenue recognition" },
  { pattern: /\bnon[-\u2010-\u2014\s]?gaap\b/i, label: "non-GAAP" },
  { pattern: /\bsegment(?:s)?\s+report/i, label: "segment reporting" },
  { pattern: /\bimpairment/i, label: "impairment" },
  { pattern: /\bgoodwill\b/i, label: "goodwill" },
  { pattern: /\bcritical\s+accounting\b/i, label: "critical accounting" },
  { pattern: /\binternal\s+control/i, label: "internal control" },
  { pattern: /\bdisclosure\s+controls?\b/i, label: "disclosure controls" },
  { pattern: /\brelated[\s-]+part(?:y|ies)\b/i, label: "related party" },
  { pattern: /\bfair\s+value\b/i, label: "fair value" },
  { pattern: /\brisk\s+factors?\b/i, label: "risk factors" },
  { pattern: /\bexecutive\s+compensation\b/i, label: "executive compensation" },
  { pattern: /\bcrypto/i, label: "crypto" },
  { pattern: /\bcybersecurity\b/i, label: "cybersecurity" },
  { pattern: /\bclimate\b/i, label: "climate" },
];

/** At most this much of a letter is read for its topics. */
const TOPIC_SCAN_CHARS = 400_000;

/**
 * A letter's document as a browser lays it out: EDGAR's SGML envelope
 * (TYPE, SEQUENCE, FILENAME) dropped, and line breaks in HTML source read as
 * spaces, so a paragraph wrapped in the source stays one paragraph.
 */
export function letterMarkup(document: string): string {
  const body = /^\s*<DOCUMENT>/i.test(document)
    ? document.replace(/^[\s\S]*?<TEXT>/i, "").replace(/<\/TEXT>[\s\S]*$/i, "")
    : document;
  return /<(?:html|body|p|div|font|table)\b/i.test(body) ? body.replace(/\s+/g, " ").trim() : body.trim();
}

/** The letter's text without markup, for its topics. */
export function letterPlainText(document: string): string {
  return decodeHtmlEntities(
    document
      .slice(0, TOPIC_SCAN_CHARS)
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ");
}

/** The listed topics a letter's text uses, in list order. */
export function letterTopics(text: string): string[] {
  return LETTER_TOPICS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.label);
}

/** The filing the SEC pane and Gloom Cloud know, for reading a letter's text. */
export function letterFilingItem(letter: CommentLetter): SecFilingItem {
  return {
    accessionNumber: letter.accessionNumber,
    form: letter.form,
    filingDate: letter.filingDate,
    cik: letter.cik,
    companyName: letter.companyName,
    filingUrl: letter.filingUrl,
    primaryDocument: letter.primaryDocument,
    primaryDocumentUrl: letter.primaryDocumentUrl,
  };
}

/** Staff letters are usually PDFs, which have no text to show here. */
export const isPdfLetter = (letter: CommentLetter): boolean =>
  /\.pdf$/i.test(letter.primaryDocument ?? letter.primaryDocumentUrl ?? "");

function letterFromFiling(filing: SecFilingItem, issuer: CommentLetterIssuer): CommentLetter {
  const form = filing.form.trim().toUpperCase();
  const cik = zeroPadCik(filing.cik) ?? issuer.cik;
  return {
    id: filing.accessionNumber,
    accessionNumber: filing.accessionNumber,
    form,
    author: form === "UPLOAD" ? "staff" : "company",
    companyName: filing.companyName ?? issuer.name,
    tickers: [issuer.ticker],
    cik,
    filingDate: filing.filingDate instanceof Date ? filing.filingDate : new Date(filing.filingDate),
    filingUrl: filing.filingUrl,
    primaryDocument: filing.primaryDocument,
    primaryDocumentUrl: filing.primaryDocumentUrl,
  };
}

/**
 * An issuer's filings, newest first, as Gloom Cloud lists them for the SEC
 * pane. `complete` is false when the list stops at the service's cap, so
 * older letters may be missing from it.
 */
export type IssuerFilingsLoader = (ticker: string, force: boolean) => Promise<{
  filings: SecFilingItem[];
  complete: boolean;
} | null>;

export class CommentLettersClient {
  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await lettersFetch.fetch(url, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : undefined,
    });
    if (!response.ok) throw new Error(`SEC full-text search failed (${response.status})`);
    return response.json();
  }

  /** CORRESP and UPLOAD filings from EDGAR full-text search, a page at a time. */
  async searchLetters(
    options: { query?: string; cik?: string; offset?: number },
    signal?: AbortSignal,
  ): Promise<Omit<CommentLetterPage, "issuer">> {
    const offset = options.offset ?? 0;
    return parseLetterSearchPage(await this.getJson(buildLetterSearchUrl({ ...options, offset }), signal), offset);
  }

  /** The company filed under exactly this ticker, from EDGAR's company lookup. */
  async resolveTicker(ticker: string, signal?: AbortSignal): Promise<CommentLetterIssuer | null> {
    const url = new URL(EFTS_URL);
    url.searchParams.set("keysTyped", ticker);
    return parseTickerMatch(await this.getJson(url.toString(), signal), ticker);
  }
}

/**
 * The pane's page loader for one query. A ticker on its own lists that
 * company's letters: from the filings Gloom Cloud already lists for the SEC
 * pane when that list is complete, otherwise from full-text search by CIK.
 * Anything else is a full-text search of the letters, newest first when
 * empty and best match first otherwise.
 */
export function createCommentLettersLoader(
  client: Pick<CommentLettersClient, "searchLetters" | "resolveTicker">,
  query: string,
  loadIssuerFilings: IssuerFilingsLoader,
) {
  const text = query.trim();
  const candidate = tickerCandidate(text);
  let issuer: Promise<CommentLetterIssuer | null> | null = null;
  let issuerFromCloud = false;
  return async ({ offset, signal, force }: PageRequest): Promise<CommentLetterPage> => {
    if (candidate && !issuer) {
      issuer = client.resolveTicker(candidate, signal).catch((error) => {
        issuer = null;
        throw error;
      });
    }
    const company = issuer ? await issuer : null;
    if (company && offset === 0) {
      const listed = await loadIssuerFilings(company.ticker, force).catch(() => null);
      issuerFromCloud = !!listed?.complete;
      if (listed?.complete) {
        const rows = listed.filings
          .filter((filing) => COMMENT_LETTER_FORM_SET.has(filing.form.trim().toUpperCase()))
          .map((filing) => letterFromFiling(filing, company));
        return { rows, hasMore: false, nextOffset: null, issuer: company, windowLimited: false };
      }
    }
    if (company && issuerFromCloud) return { rows: [], hasMore: false, nextOffset: null, issuer: company, windowLimited: false };
    const page = await client.searchLetters(company ? { cik: company.cik, offset } : { query: text, offset }, signal);
    return { ...page, issuer: company };
  };
}
