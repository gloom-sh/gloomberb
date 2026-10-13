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
  couponRate: number | null;
  maturityDate: string | null;
  lastSalePrice: number | null;
  lastSaleYield: number | null;
  priceChangeNumber: number | null;
  lastTradeDate: string | null;
  traceGradeCode: string | null;
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

/** Rows from a reporting envelope. Null when the payload is not that shape. */
function corporateBondPayloadRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = recordOrNull(payload);
  if (!record) return null;
  if ("data" in record) return dataRows(record.data);
  const body = recordOrNull(record.returnBody);
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
 * One page of bonds from a reporting payload, newest last sale first.
 * An unrecognized payload is an empty page; the fetch rejects that case.
 */
function parseCorporateBondTape(payload: unknown): CorporateBond[] {
  const rows = corporateBondPayloadRows(payload);
  if (!rows) return [];
  const seen = new Map<string, number>();
  return rows
    .map((row, index) => parseBond(row, index, seen))
    .filter((bond): bond is CorporateBond => bond !== null)
    .sort(byLastTrade)
    .slice(0, PAGE_SIZE);
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(failureText(response.status, text.slice(0, 180)));
  }
}

/**
 * The dataset ignores `compareFields`. `compareFilters` is what drops bonds
 * with no last sale, which a descending sort otherwise returns first.
 * The route also refuses the body until the session cookie is echoed.
 */
async function postBondPage(signal: AbortSignal): Promise<unknown> {
  const session = await httpFetch(ENDPOINT, { headers: REQUEST_HEADERS, signal });
  const token = xsrfToken(session);
  await session.body?.cancel().catch(() => {});
  if (!token) throw new Error(failureText(session.status, "session"));

  const response = await httpFetch(ENDPOINT, {
    method: "POST",
    headers: {
      ...REQUEST_HEADERS,
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": token,
      Cookie: `XSRF-TOKEN=${token}`,
    },
    body: JSON.stringify({
      fields: BOND_FIELDS,
      compareFilters: [{ fieldName: "lastTradeDate", compareType: "GREATER", fieldValue: "1900-01-01" }],
      sortFields: ["-lastTradeDate"],
      limit: PAGE_SIZE,
      offset: 0,
    }),
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

/** The latest page of corporate and agency bond sales. One hundred rows, not the whole market. */
export async function fetchCorporateBonds(signal?: AbortSignal): Promise<CorporateBond[]> {
  const payload = await postBondPage(signalWithTimeout(signal, FETCH_TIMEOUT_MS));
  return parseCorporateBondTape(payload);
}
