import { signalWithTimeout } from "../../../utils/async-deadline";
import { httpFetch } from "../../../utils/http-transport";
import { isoDateOrNull, numericOrNull, recordOrNull, textOrNull } from "../../../utils/guards";

const ENDPOINT = "https://services-dynarep.ddwa.finra.org/public/reporting/v2/data/group/FixedIncomeMarket/name/corporateAndAgencySecurities";
const PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 20_000;

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
 * name, and by its symbol root when the text reads as a symbol (`WHR`).
 */
export type BondQuery =
  | { kind: "cusip"; text: string; cusip: string }
  | { kind: "issuer"; text: string; name: string; symbol: string | null };

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
  const text = input.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const upper = text.toUpperCase();
  if (isCusip(upper)) return { kind: "cusip", text, cusip: upper };
  return { kind: "issuer", text, name: upper, symbol: /^[A-Z][A-Z0-9.]{0,5}$/.test(upper) ? upper : null };
}

interface CompareFilter {
  fieldName: string;
  compareType: "EQUAL" | "GREATER" | "BEGINS_WITH";
  fieldValue: string;
}

/** Bonds with no last sale come first in a descending sort; this keeps them out. */
const TRADED: CompareFilter = { fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" };

/**
 * The filters of each request a query makes, filtered by the tape itself
 * rather than in a page of the latest sales: one for a CUSIP or the market,
 * two for text that can be a name and a symbol, merged after.
 */
export function bondTapeFilters(query: BondQuery | null): CompareFilter[][] {
  if (!query) return [[TRADED]];
  if (query.kind === "cusip") return [[{ fieldName: "cusip", compareType: "EQUAL", fieldValue: query.cusip }, TRADED]];
  return [
    [{ fieldName: "issuerName", compareType: "BEGINS_WITH", fieldValue: query.name }, TRADED],
    ...(query.symbol ? [[{ fieldName: "issueSymbolIdentifier", compareType: "BEGINS_WITH" as const, fieldValue: query.symbol }, TRADED]] : []),
  ];
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

/**
 * Whether an issue belongs to the symbol asked for: `WHR` takes `WHR4800338`
 * and `WHR.GM` but not `WHRL1234`, so a short root does not pull in every
 * longer one that starts with it.
 */
function issueOfSymbol(bond: Pick<CorporateBond, "symbol">, symbol: string): boolean {
  const issue = bond.symbol?.toUpperCase();
  return !!issue && issue.startsWith(symbol) && !/[A-Z]/.test(issue.charAt(symbol.length));
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

function parseBond(raw: unknown, index: number, seen: Map<string, number>): CorporateBond | null {
  const record = recordOrNull(raw);
  if (!record) return null;
  const base = bondId(record, index);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return {
    id: count === 0 ? base : `${base}#${count + 1}`,
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

/**
 * The bonds of one or more reporting payloads, newest last sale first. An
 * issue an earlier payload already gave (a name and a symbol request both
 * answer it) is listed once. An unrecognized payload adds none; the fetch
 * rejects that case.
 */
function parseCorporateBondTape(payloads: readonly unknown[]): CorporateBond[] {
  const seen = new Map<string, number>();
  const earlier = new Set<string>();
  const bonds: CorporateBond[] = [];
  let index = 0;
  for (const payload of payloads) {
    const issues: string[] = [];
    for (const row of corporateBondPayloadRows(payload) ?? []) {
      const record = recordOrNull(row);
      const issue = record ? textOrNull(record.cusip) ?? textOrNull(record.issueSymbolIdentifier) : null;
      if (issue && earlier.has(issue)) continue;
      if (issue) issues.push(issue);
      const bond = parseBond(row, index, seen);
      index += 1;
      if (bond) bonds.push(bond);
    }
    for (const issue of issues) earlier.add(issue);
  }
  return bonds.sort(byLastTrade).slice(0, PAGE_SIZE);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
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

export interface BondTape {
  query: BondQuery | null;
  /** Newest last sale first, at most one hundred. */
  bonds: CorporateBond[];
  /**
   * The newest sale the rows show; for a query with no rows, the market's
   * newest, the day the empty answer is for. Null when unknown.
   */
  tradeDate: string | null;
}

/**
 * The latest corporate and agency bond sales: the market's newest hundred,
 * or every issue of one issuer, symbol or CUSIP, asked of the tape itself.
 */
export async function fetchBondTape(input: string, signal?: AbortSignal): Promise<BondTape> {
  const query = parseBondQuery(input);
  const deadline = signalWithTimeout(signal, FETCH_TIMEOUT_MS);
  const token = await openSession(deadline);
  const payloads = await Promise.all(bondTapeFilters(query).map((filters) => postBondPage(token, filters, PAGE_SIZE, deadline)));
  const parsed = parseCorporateBondTape(payloads);
  const bonds = query?.kind === "issuer" && query.symbol
    ? parsed.filter((bond) => bond.issuerName.toUpperCase().startsWith(query.name) || issueOfSymbol(bond, query.symbol!))
    : parsed;
  if (bonds.length > 0 || !query) return { query, bonds, tradeDate: latestTradeDate(bonds) };
  // No prints for the query: date the answer by the market's newest sale.
  const market = await postBondPage(token, [TRADED], 1, deadline)
    .then((payload) => latestTradeDate(parseCorporateBondTape([payload])))
    .catch(() => null);
  return { query, bonds, tradeDate: market };
}

/** What an empty answer to a query says: `No prints for CMLSQ on 2026-10-16.` */
export function noPrintsText(query: BondQuery, tradeDate: string | null): string {
  return tradeDate ? `No prints for ${query.text} on ${tradeDate}.` : `No prints for ${query.text}.`;
}
