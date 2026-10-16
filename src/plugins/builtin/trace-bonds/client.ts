import { shortCompanyName } from "../../../tickers/company-name";
import type { DataProvider } from "../../../types/data-provider";
import { signalWithTimeout } from "../../../utils/async-deadline";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { httpFetch } from "../../../utils/http-transport";
import { isoDateOrNull, numericOrNull, recordOrNull, textOrNull } from "../../../utils/guards";
import { zonedDateKey } from "../../../utils/zoned-date-time";

const ENDPOINT = "https://services-dynarep.ddwa.finra.org/public/reporting/v2/data/group/FixedIncomeMarket/name/corporateAndAgencySecurities";
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 20_000;
/** The most of what was typed that is sent; the tape's longest issuer names are shorter. */
const MAX_QUERY_LENGTH = 80;
/** The tape's calendar: a bond that matures today has stopped trading by tonight there. */
const TAPE_TIME_ZONE = "America/New_York";

const REQUEST_HEADERS = {
  Accept: "application/json",
  Origin: "https://www.finra.org",
  Referer: "https://www.finra.org/finra-data/fixed-income/corp-and-agency/trade",
  "User-Agent": "gloomberb",
};

const BOND_FIELDS = [
  "issuerName",
  "couponRate",
  "maturityDate",
  "lastSalePrice",
  "lastSaleYield",
  "priceChangeNumber",
  "lastTradeDate",
  "traceGradeCode",
  "cusip",
  "issueSymbolIdentifier",
];

export interface CorporateBond {
  id: string;
  issuerName: string;
  cusip: string | null;
  /** The tape's own symbol for the issue: the issuer's root, then digits (`WHR4800338`). */
  symbol: string | null;
  couponRate: number | null;
  maturityDate: string | null;
  lastSalePrice: number | null;
  lastSaleYield: number | null;
  priceChangeNumber: number | null;
  lastTradeDate: string | null;
  traceGradeCode: string | null;
}

/**
 * What the tape is asked for: one CUSIP, or an issuer by the start of its
 * name, and by its symbol root when the text reads as one (`WHR`).
 */
export type BondQuery =
  | { kind: "cusip"; text: string; cusip: string }
  | {
    kind: "issuer";
    text: string;
    /** The start of the issuer's name, upper case as the tape spells it. */
    name: string;
    /** The tape's own symbol root, matched exactly: `WHR` is `WHR4800338` and `WHR.GM`, never `WHRL…`. */
    root: string | null;
    /** A stock ticker the text can be, whose company is asked for when nothing else matches. */
    ticker: string | null;
  };

/** The CUSIP check digit of its first eight characters, or null when one is not a CUSIP character. */
function cusipCheckDigit(base: string): number | null {
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    const char = base[index]!;
    let value = /\d/.test(char) ? Number(char)
      : /[A-Z]/.test(char) ? char.charCodeAt(0) - 55
        : char === "*" ? 36 : char === "@" ? 37 : char === "#" ? 38 : null;
    if (value == null) return null;
    if (index % 2 === 1) value *= 2;
    sum += Math.floor(value / 10) + (value % 10);
  }
  return (10 - (sum % 10)) % 10;
}

export function isCusip(text: string): boolean {
  return /^[0-9A-Z*@#]{8}\d$/.test(text) && cusipCheckDigit(text) === Number(text[8]);
}

/** Null for no text: the market-wide tape. */
export function parseBondQuery(input: string): BondQuery | null {
  const text = input.trim().replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH).trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (isCusip(upper)) return { kind: "cusip", text, cusip: upper };
  return {
    kind: "issuer",
    text,
    name: upper,
    root: /^[A-Z]{1,6}$/.test(upper) ? upper : null,
    ticker: /^[A-Z]{1,6}(?:[.-][A-Z]{1,2})?$/.test(upper) ? upper : null,
  };
}

interface CompareFilter {
  fieldName: string;
  compareType: "EQUAL" | "GREATER" | "LESSER" | "BEGINS_WITH";
  /** Null with EQUAL matches a field the issue has no value for. */
  fieldValue: string | null;
}

/** One request to the tape, and what its rows must be: checked again before they merge, so no filter is taken on trust. */
export interface BondRequest {
  filters: CompareFilter[];
  accepts: (bond: CorporateBond) => boolean;
}

/** Bonds with no last sale come first in a descending sort; this keeps them out. */
const TRADED: CompareFilter = { fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" };

const anyBond = () => true;

/**
 * Whether an issue belongs to the symbol root asked for: `WHR` takes
 * `WHR4800338` and `WHR.GM` but not `WHRL1234`, so a short root does not
 * pull in every longer one that starts with it.
 */
function issueOfRoot(bond: Pick<CorporateBond, "symbol">, root: string): boolean {
  const issue = bond.symbol?.toUpperCase();
  return !!issue && issue.startsWith(root) && /^[./\d]/.test(issue.slice(root.length));
}

/**
 * The root's issues and no longer root's, filtered by the tape: symbols
 * continue the root with a dot, a slash or a digit, which sort between
 * `WHR-` and `WHR:`, and a letter, which starts another root, sorts after.
 */
function rootFilters(root: string): CompareFilter[] {
  return [
    { fieldName: "issueSymbolIdentifier", compareType: "GREATER", fieldValue: `${root}-` },
    { fieldName: "issueSymbolIdentifier", compareType: "LESSER", fieldValue: `${root}:` },
  ];
}

/** One or two letters start too many names (`GE` starts GENERAL MOTORS and GEORGIA POWER), so they are a first word. */
function nameFilter(name: string): CompareFilter {
  return { fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: name.length < 3 ? `${name} ` : name };
}

function unmatured(bond: Pick<CorporateBond, "maturityDate">, today: string): boolean {
  return bond.maturityDate == null || bond.maturityDate > today;
}

/**
 * The requests a query makes, each filtered by the tape itself rather than in
 * a page of the latest sales: the market's, one CUSIP's (matured or not), or
 * an issuer's by name and by symbol root, merged after. An issuer's bonds
 * that matured by `today` are left out on the tape's side so they do not
 * take the page; a filter on the date also drops perpetuals, which have
 * none, so each is asked twice, once for each.
 */
export function bondTapeRequests(query: BondQuery | null, today: string): BondRequest[] {
  if (!query) return [{ filters: [TRADED], accepts: anyBond }];
  if (query.kind === "cusip") {
    return [{ filters: [{ fieldName: "cusip", compareType: "EQUAL", fieldValue: query.cusip }, TRADED], accepts: anyBond }];
  }
  const live = (bond: CorporateBond) => unmatured(bond, today);
  const name = nameFilter(query.name);
  const terms: Array<{ filters: CompareFilter[]; accepts: (bond: CorporateBond) => boolean }> = [
    { filters: [name], accepts: (bond) => live(bond) && bond.issuerName.toUpperCase().startsWith(name.fieldValue!) },
    ...(query.root ? [{ filters: rootFilters(query.root), accepts: (bond: CorporateBond) => live(bond) && issueOfRoot(bond, query.root!) }] : []),
  ];
  return terms.flatMap(({ filters, accepts }) => [
    { filters: [...filters, { fieldName: "maturityDate", compareType: "GREATER", fieldValue: today }, TRADED], accepts },
    { filters: [...filters, { fieldName: "maturityDate", compareType: "EQUAL", fieldValue: null }, TRADED], accepts },
  ]);
}

function bondTapeRequestBody(filters: readonly CompareFilter[], limit = PAGE_SIZE) {
  return {
    fields: BOND_FIELDS,
    compareFilters: filters,
    sortFields: ["-lastTradeDate"],
    limit,
    offset: 0,
  };
}

/** A sale date as its day. Text that is not a date is kept as published. */
function saleDate(value: unknown): string | null {
  return isoDateOrNull(value) ?? textOrNull(value);
}

/** With no earlier sale to compare, the feed sends the whole price as the change. */
function saleChange(change: number | null, price: number | null): number | null {
  return change != null && price != null && price !== 0 && change === price ? null : change;
}

function scrubVendor(text: string): string {
  return text.replace(/\b(?:FINRA|TRACE)\b/gi, " ").replace(/\s+/g, " ").trim();
}

function failureText(status: number, detail: string): string {
  const cleaned = scrubVendor(detail);
  return cleaned ? `Bond tape request failed (${status}): ${cleaned}` : `Bond tape request failed (${status})`;
}

function failureDetail(payload: unknown): string {
  const record = recordOrNull(payload);
  return textOrNull(record?.statusMessage) ?? textOrNull(record?.message) ?? "";
}

function xsrfToken(response: Response): string | null {
  const listed = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const header = response.headers.get("set-cookie");
  const cookies = listed.length > 0 ? listed : header ? [header] : [];
  for (const cookie of cookies) {
    const match = /XSRF-TOKEN=([^;,\s]+)/.exec(cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

function dataRows(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Rows from a reporting envelope. Null when the payload is not that shape. A
 * filter that matches nothing answers 204 with no data, which is no rows.
 */
function corporateBondPayloadRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = recordOrNull(payload);
  if (!record) return null;
  if ("data" in record) return dataRows(record.data);
  const body = recordOrNull(record.returnBody);
  if (body && body.statusCode === 204 && body.data == null) return [];
  if (body && "data" in body) return dataRows(body.data);
  return null;
}

function bondId(raw: Record<string, unknown>, index: number): string {
  return textOrNull(raw.cusip)
    ?? textOrNull(raw.issueSymbolIdentifier)
    ?? `${textOrNull(raw.issuerName) ?? ""}|${textOrNull(raw.maturityDate) ?? ""}|${index}`;
}

/** A row as a bond; its id is the issue's until `mergeBondAnswers` tells repeats apart. */
function parseBond(raw: unknown, index: number): CorporateBond | null {
  const record = recordOrNull(raw);
  if (!record) return null;
  return {
    id: bondId(record, index),
    issuerName: textOrNull(record.issuerName) ?? "",
    cusip: textOrNull(record.cusip),
    symbol: textOrNull(record.issueSymbolIdentifier),
    couponRate: numericOrNull(record.couponRate),
    maturityDate: saleDate(record.maturityDate),
    lastSalePrice: numericOrNull(record.lastSalePrice),
    lastSaleYield: numericOrNull(record.lastSaleYield),
    priceChangeNumber: saleChange(numericOrNull(record.priceChangeNumber), numericOrNull(record.lastSalePrice)),
    lastTradeDate: saleDate(record.lastTradeDate),
    traceGradeCode: textOrNull(record.traceGradeCode),
  };
}

function byLastTrade(left: CorporateBond, right: CorporateBond): number {
  if (left.lastTradeDate === right.lastTradeDate) return 0;
  if (left.lastTradeDate == null) return 1;
  if (right.lastTradeDate == null) return -1;
  return left.lastTradeDate < right.lastTradeDate ? 1 : -1;
}

/** How many issues matched a request in all, which the tape states beside the page it sends. */
function recordTotal(payload: unknown): number | null {
  const headers = recordOrNull(recordOrNull(recordOrNull(payload)?.returnBody)?.headers);
  const value = headers?.["Record-Total"] ?? headers?.["record-total"];
  const total = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(total) ? total : null;
}

interface BondAnswer {
  payload: unknown;
  accepts: (bond: CorporateBond) => boolean;
  limit: number;
}

/**
 * The bonds of one or more answers, newest last sale first, at most a page.
 * Each answer's rows are held to its request before they merge, so the page
 * is cut from bonds that belong in it. An issue an earlier answer already
 * gave (a name and a symbol request both answer it) is listed once.
 * `truncated` when more issues matched than the page shows.
 */
function mergeBondAnswers(answers: readonly BondAnswer[]): { bonds: CorporateBond[]; truncated: boolean } {
  const seen = new Map<string, number>();
  const earlier = new Set<string>();
  const bonds: CorporateBond[] = [];
  let truncated = false;
  let index = 0;
  for (const { payload, accepts, limit } of answers) {
    const rows = corporateBondPayloadRows(payload) ?? [];
    if (rows.length >= limit || (recordTotal(payload) ?? 0) > rows.length) truncated = true;
    const issues: string[] = [];
    for (const row of rows) {
      const bond = parseBond(row, index);
      index += 1;
      if (!bond || !accepts(bond)) continue;
      const issue = bond.cusip ?? bond.symbol;
      if (issue && earlier.has(issue)) continue;
      if (issue) issues.push(issue);
      const count = seen.get(bond.id) ?? 0;
      seen.set(bond.id, count + 1);
      bonds.push(count === 0 ? bond : { ...bond, id: `${bond.id}#${count + 1}` });
    }
    for (const issue of issues) earlier.add(issue);
  }
  bonds.sort(byLastTrade);
  return { bonds: bonds.slice(0, PAGE_SIZE), truncated: truncated || bonds.length > PAGE_SIZE };
}

/** A filter that matches nothing can answer 204 with no body: no rows, not a failure. */
async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.status === 204 || !text.trim()) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(failureText(response.status, text.slice(0, 180)));
  }
}

/** The route refuses a request body until the session cookie is echoed; one session serves every request of a load. */
async function openSession(signal: AbortSignal): Promise<string> {
  const session = await httpFetch(ENDPOINT, { headers: REQUEST_HEADERS, signal });
  const token = xsrfToken(session);
  await session.body?.cancel().catch(() => {});
  if (!token) throw new Error(failureText(session.status, "session"));
  return token;
}

/**
 * The dataset ignores `compareFields`; `compareFilters` is what it filters
 * by, on its side, before the limit is applied.
 */
async function postBondPage(token: string, filters: readonly CompareFilter[], limit: number, signal: AbortSignal): Promise<unknown> {
  const response = await httpFetch(ENDPOINT, {
    method: "POST",
    headers: {
      ...REQUEST_HEADERS,
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
      Cookie: `XSRF-TOKEN=${token}`,
    },
    body: JSON.stringify(bondTapeRequestBody(filters, limit)),
    signal,
  });
  const payload = await readPayload(response);
  if (!response.ok || recordOrNull(payload)?.status === "failure") {
    throw new Error(failureText(response.status, failureDetail(payload)));
  }
  if (corporateBondPayloadRows(payload) == null) {
    throw new Error("Bond tape response was not recognized");
  }
  return payload;
}

function latestTradeDate(bonds: readonly CorporateBond[]): string | null {
  let latest: string | null = null;
  for (const bond of bonds) {
    if (bond.lastTradeDate && (latest == null || bond.lastTradeDate > latest)) latest = bond.lastTradeDate;
  }
  return latest;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every request of a query at once. One that fails does not fail the others:
 * their rows still show and the failure is listed. Only when none answers
 * does the load fail.
 */
async function askTape(token: string, requests: readonly BondRequest[], signal: AbortSignal) {
  const settled = await Promise.allSettled(requests.map((request) => postBondPage(token, request.filters, PAGE_SIZE, signal)));
  const answers: BondAnswer[] = [];
  const failures: string[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") answers.push({ payload: result.value, accepts: requests[index]!.accepts, limit: PAGE_SIZE });
    else failures.push(errorText(result.reason));
  }
  if (answers.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
  return { ...mergeBondAnswers(answers), failures: [...new Set(failures)] };
}

/**
 * A company's name as the tape spells its issuers: upper case, without its
 * legal form, a closing "Holdings" (the tape writes `HLDGS`) or periods.
 * `Cumulus Media Inc.` is `CUMULUS MEDIA`, which starts `CUMULUS MEDIA NEW
 * HLDGS INC`. Null for a name with nothing left.
 */
export function tapeIssuerName(company: string): string | null {
  const name = shortCompanyName(company).toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ")
    .replace(/ HOLDINGS?$/, "").slice(0, MAX_QUERY_LENGTH).trim();
  return name.length >= 2 ? name : null;
}

/**
 * The company a stock ticker's quote names, read the way other panes resolve
 * an issuer (`resolveIssuerListing`). Null without a market data source or
 * when the quote names nothing but the ticker.
 */
export async function quotedCompanyName(
  marketData: Pick<DataProvider, "getQuote"> | null | undefined,
  ticker: string,
  exchange?: string,
): Promise<string | null> {
  if (!marketData) return null;
  const listing = parsePublicTickerKey(ticker);
  const quote = await marketData.getQuote(listing.symbol, exchange ?? listing.exchange ?? "");
  const name = quote.name?.trim();
  return name && name.toUpperCase() !== listing.symbol.toUpperCase() ? name : null;
}

/** The issuer a stock ticker was read as when no bonds trade under the ticker itself. */
export interface BondIssuer {
  /** What the ticker's quote calls the company: `Cumulus Media Inc.` */
  company: string;
  /** The start of the issuer name the tape was asked for: `CUMULUS MEDIA`. */
  name: string;
}

export interface BondTape {
  query: BondQuery | null;
  /** Newest last sale first, at most one hundred. */
  bonds: CorporateBond[];
  /**
   * The newest sale the rows show; for a query with no rows, the market's
   * newest, the day the empty answer is for. Null when unknown.
   */
  tradeDate: string | null;
  /** A query matched more issues than the hundred shown. The market's tape is always its latest hundred and never says so. */
  truncated: boolean;
  /** Set when a ticker had no bonds of its own and its company's name was asked for instead. */
  issuer: BondIssuer | null;
  /** Requests that failed while others answered: the rows leave out what they would have given. */
  failures: string[];
}

export interface BondTapeOptions {
  signal?: AbortSignal;
  /** The tape's calendar day; an issuer's bonds that matured by it are left out. Today in New York by default. */
  today?: string;
  /** The company a stock ticker's quote names (`quotedCompanyName`), asked once when the ticker finds nothing. */
  companyName?: (ticker: string) => Promise<string | null>;
}

/**
 * The latest corporate and agency bond sales: the market's newest hundred,
 * or the live issues of one issuer, symbol root or CUSIP, asked of the tape
 * itself. A stock ticker with no bonds under its own symbol or name is
 * asked again once by its company's name.
 */
export async function fetchBondTape(input: string, options: BondTapeOptions = {}): Promise<BondTape> {
  const query = parseBondQuery(input);
  const today = options.today ?? zonedDateKey(Date.now(), TAPE_TIME_ZONE);
  const deadline = signalWithTimeout(options.signal, FETCH_TIMEOUT_MS);
  const token = await openSession(deadline);
  const first = await askTape(token, bondTapeRequests(query, today), deadline);
  let answer = first;
  let issuer: BondIssuer | null = null;
  if (first.bonds.length === 0 && query?.kind === "issuer" && query.ticker && options.companyName) {
    const company = await options.companyName(query.ticker).catch(() => null);
    const name = company ? tapeIssuerName(company) : null;
    if (company && name && name !== query.name) {
      issuer = { company, name };
      answer = await askTape(token, bondTapeRequests({ kind: "issuer", text: name, name, root: null, ticker: null }, today), deadline)
        .catch((error: unknown) => ({ bonds: [], truncated: false, failures: [errorText(error)] }));
      answer = { ...answer, failures: [...new Set([...first.failures, ...answer.failures])] };
    }
  }
  const { bonds, truncated, failures } = answer;
  const result = { query, bonds, truncated: !!query && truncated, issuer, failures };
  if (bonds.length > 0 || !query) return { ...result, tradeDate: latestTradeDate(bonds) };
  // No prints for the query: date the answer by the market's newest sale.
  const market = await postBondPage(token, [TRADED], 1, deadline)
    .then((payload) => latestTradeDate(mergeBondAnswers([{ payload, accepts: anyBond, limit: 1 }]).bonds))
    .catch(() => null);
  return { ...result, tradeDate: market };
}

/**
 * What an empty answer to a query says: `No prints for CMLSQ on 2026-10-16.`,
 * naming the company's issuer name too when that was asked.
 */
export function noPrintsText(query: BondQuery, tradeDate: string | null, issuer: BondIssuer | null = null): string {
  const asked = issuer ? `${query.text} or ${issuer.name}` : query.text;
  return tradeDate ? `No prints for ${asked} on ${tradeDate}.` : `No prints for ${asked}.`;
}

/** What a ticker read as its company says: `Showing bonds for CUMULUS MEDIA (Cumulus Media Inc.): none trade under CMLSQ.` */
export function issuerFallbackText(query: BondQuery, issuer: BondIssuer): string {
  return `Showing bonds for ${issuer.name} (${issuer.company}): none trade under ${query.text}.`;
}

/** A query that matched more issues than one page holds. */
export const TRUNCATED_TEXT = "First 100 issues, newest last sale first.";
