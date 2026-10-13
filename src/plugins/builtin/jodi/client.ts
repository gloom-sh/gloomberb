import { signalWithTimeout } from "../../../utils/async-deadline";
import { recordOrNull } from "../../../utils/guards";
import { httpFetch } from "../../../utils/http-transport";
import { createThrottledFetch } from "../../../utils/throttled-fetch";
import { readZipTexts } from "../shared/zip-text";
import {
  BALANCE_COUNTRIES,
  GAS_UNIT,
  OIL_UNIT,
  type BalanceCommodity,
  type BalanceRow,
  type Board,
} from "./model";

const OIL_URL = "https://www.jodidata.org/_resources/files/downloads/oil-data/world_Primary_CSV.zip";
const GAS_LISTING_URL = "https://api.publisher.jodidata.org/web/files/gas";
const DOWNLOAD_TIMEOUT_MS = 180_000;

const jodiFetch = createThrottledFetch({
  requestsPerMinute: 12,
  maxRetries: 2,
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
  backoffBaseMs: 500,
  dedupeGetRequests: true,
  defaultHeaders: {
    Accept: "*/*",
    "User-Agent": "gloomberb",
  },
  transport: (url: string, init?: RequestInit) => httpFetch(url, init),
});

type BalanceField = "production" | "demand" | "imports" | "exports" | "stocks";
type BalanceCells = Record<BalanceField, number | null>;

const OIL_PRODUCTS = new Set(["CRUDEOIL", "NGL", "OTHERCRUDE", "TOTCRUDE"]);
const OIL_FIELDS: Record<string, BalanceField> = {
  "INDPROD:KBD": "production",
  "TOTDEMO:KBD": "demand",
  "TOTIMPSB:KBD": "imports",
  "TOTEXPSB:KBD": "exports",
  "CLOSTLV:KBBL": "stocks",
};
const GAS_FIELDS: Record<string, BalanceField> = {
  "INDPROD:M3": "production",
  "TOTDEMO:M3": "demand",
  "TOTIMPSB:M3": "imports",
  "TOTEXPSB:M3": "exports",
  "CLOSTLV:M3": "stocks",
};

const COUNTRY_NAME = new Map(BALANCE_COUNTRIES.map((row) => [row.code, row.country]));
const COUNTRY_KEY = new Map(BALANCE_COUNTRIES.map((row) => [
  (row.code.charCodeAt(0) << 8) | row.code.charCodeAt(1),
  row.code,
]));

export interface Balances {
  oil: Board;
  gas: Board | null;
}

function stripBom(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  if (text.startsWith("\u00EF\u00BB\u00BF")) return text.slice(3);
  return text;
}

function blankCells(): BalanceCells {
  return { production: null, demand: null, imports: null, exports: null, stocks: null };
}

function observation(raw: string | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || text === "-" || text === "x" || text.toUpperCase() === "N/A") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function columnIndex(header: string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) throw new Error("The file is not a monthly balance table.");
  return index;
}

/** Latest month of crude or natural gas balances for the tracked countries. */
export function parseJodiCsv(text: string): Board {
  const source = stripBom(text);
  if (!source.trim()) throw new Error("The file is empty.");
  const headerBreak = source.indexOf("\n");
  const headerEnd = headerBreak < 0 ? source.length : headerBreak;
  const header = source.slice(0, headerEnd).replace(/\r$/, "").split(",").map((column) => column.trim());
  const area = columnIndex(header, "REF_AREA");
  const period = columnIndex(header, "TIME_PERIOD");
  const product = columnIndex(header, "ENERGY_PRODUCT");
  const flow = columnIndex(header, "FLOW_BREAKDOWN");
  const unit = columnIndex(header, "UNIT_MEASURE");
  const value = columnIndex(header, "OBS_VALUE");
  const width = Math.max(area, period, product, flow, unit, value) + 1;

  let kind: BalanceCommodity | null = null;
  let month = "";
  const cells = new Map<string, BalanceCells>();
  const areaFirst = area === 0;
  let pos = headerBreak < 0 ? source.length : headerBreak + 1;

  while (pos < source.length) {
    let end = source.indexOf("\n", pos);
    if (end < 0) end = source.length;
    let lineEnd = end;
    if (lineEnd > pos && source.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
    const next = end < source.length ? end + 1 : source.length;
    if (areaFirst) {
      if (lineEnd - pos < 3) {
        pos = next;
        continue;
      }
      const key = (source.charCodeAt(pos) << 8) | source.charCodeAt(pos + 1);
      if (source.charCodeAt(pos + 2) !== 44 || !COUNTRY_KEY.has(key)) {
        pos = next;
        continue;
      }
    }
    const parts = source.slice(pos, lineEnd).split(",");
    pos = next;
    if (parts.length < width) continue;
    const code = parts[area];
    if (!code || !COUNTRY_NAME.has(code)) continue;
    const productCode = parts[product];
    const nextKind: BalanceCommodity | null = productCode === "NATGAS"
      ? "gas"
      : productCode && OIL_PRODUCTS.has(productCode) ? "oil" : null;
    if (!nextKind) continue;
    if (kind && kind !== nextKind) throw new Error("The file mixes oil and gas balances.");
    kind = nextKind;
    if (nextKind === "oil" && productCode !== "CRUDEOIL") continue;
    const field = (nextKind === "oil" ? OIL_FIELDS : GAS_FIELDS)[`${parts[flow]}:${parts[unit]}`];
    if (!field) continue;
    const at = parts[period];
    if (!at || !/^\d{4}-\d{2}$/.test(at)) continue;
    const observed = observation(parts[value]);
    if (observed == null) continue;
    if (at < month) continue;
    if (at > month) {
      month = at;
      cells.clear();
    }
    let row = cells.get(code);
    if (!row) {
      row = blankCells();
      cells.set(code, row);
    }
    row[field] = observed;
  }

  if (!kind || !month) throw new Error("The file has no balance rows.");
  const unitLabel = kind === "oil" ? OIL_UNIT : GAS_UNIT;
  const rows: BalanceRow[] = BALANCE_COUNTRIES.map(({ code, country }) => {
    const row = cells.get(code);
    return {
      country,
      production: row?.production ?? null,
      demand: row?.demand ?? null,
      imports: row?.imports ?? null,
      exports: row?.exports ?? null,
      stocks: row?.stocks ?? null,
      unit: unitLabel,
    };
  });
  return { month, commodity: kind, rows };
}

async function readBalanceCsv(url: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await jodiFetch.fetch(url, { signal: signalWithTimeout(signal, DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("The balance request was cancelled.");
    throw new Error("The balance file could not be downloaded.");
  }
  if (!response.ok) throw new Error(`The balance file could not be downloaded (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const csv = (await readZipTexts(bytes)).find((entry) => entry.name.toLowerCase().endsWith(".csv"));
  if (!csv?.text.trim()) throw new Error("The archive had no balance table.");
  return csv.text;
}

function gasZipUrl(payload: unknown): string | null {
  const record = recordOrNull(payload);
  const id = record?.publicationId;
  if ((typeof id !== "number" && typeof id !== "string") || !Array.isArray(record?.files)) return null;
  const filename = record.files.map(recordOrNull).find((row) => (
    row?.format === "CSV" && row.ignore !== true
      && typeof row.filename === "string" && row.filename.toLowerCase().endsWith(".zip")
  ))?.filename;
  if (typeof filename !== "string") return null;
  return `https://www.jodidata.org/jodi-publisher/gas/${id}/${encodeURIComponent(filename)}`;
}

async function readGas(signal?: AbortSignal): Promise<Board | null> {
  try {
    const listing = await jodiFetch.fetchJson<unknown>(GAS_LISTING_URL, { signal: signalWithTimeout(signal, DOWNLOAD_TIMEOUT_MS) });
    const url = gasZipUrl(listing);
    if (!url) return null;
    const board = parseJodiCsv(await readBalanceCsv(url, signal));
    return board.commodity === "gas" ? board : null;
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("The balance request was cancelled.");
    return null;
  }
}

export async function fetchBalances(signal?: AbortSignal): Promise<Balances> {
  const [oil, gas] = await Promise.all([
    readBalanceCsv(OIL_URL, signal).then((text) => parseJodiCsv(text)),
    readGas(signal),
  ]);
  if (oil.commodity !== "oil") throw new Error("The oil file did not contain crude balances.");
  return { oil, gas };
}
