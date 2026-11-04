/**
 * Reads a broker's positions export (the CSV a brokerage's positions or
 * holdings page downloads) into the positions it lists: shares, cost and,
 * where the file has one, the purchase date. Fidelity, Schwab, Vanguard,
 * E*TRADE and Merrill are recognised by their columns; any other file works
 * when it has a Symbol (or Ticker) and a Quantity (or Shares) column.
 *
 * Rows that are not a holding of a security are left out: cash and money
 * market sweeps, pending activity, totals, account titles and footers.
 * Options and bonds are listed as skipped with the reason, never read as
 * shares of a stock.
 */
import { readCalendarDate } from "../../utils/calendar-date";
import { isCurrencyCode } from "../../utils/currency-pair";
import { normalizeHeldCurrencyCode, resolveCurrencyUnit } from "../../utils/currency-units";

export type PositionsLayoutId = "fidelity" | "schwab" | "vanguard" | "etrade" | "merrill" | "generic";

/** How each layout is named to the person importing it. */
export const POSITIONS_LAYOUT_NAMES: Readonly<Record<PositionsLayoutId, string>> = {
  fidelity: "Fidelity positions export",
  schwab: "Schwab positions export",
  vanguard: "Vanguard holdings export",
  etrade: "E*TRADE portfolio export",
  merrill: "Merrill holdings export",
  generic: "Positions table",
};

/** The broker exports recognised by their columns, in the order the help names them. */
export const POSITIONS_EXPORT_BROKERS = ["Fidelity", "Schwab", "Vanguard", "E*TRADE", "Merrill"] as const;

/** A holding the file lists, its rows of one symbol added up. */
export interface FilePosition {
  /** The symbol as the file writes it, cleaned of marks (BRK/B reads BRK.B). */
  symbol: string;
  description: string | null;
  /** Signed: a negative count is a short. */
  shares: number;
  /** Cost per share in `currency`, when the file gives a cost (per share, in total, or as value less gain). */
  avgCost: number | null;
  /** The cost's currency when the file says it (US brokers' exports are in USD); null for the listing's. */
  currency: string | null;
  /** YYYY-MM-DD; with several rows, the earliest. */
  dateAcquired: string | null;
  /** The file's lines (from 1) the position was read from. */
  lines: number[];
}

/** A row that names something but is not imported, and why. */
export interface SkippedFileRow {
  line: number;
  /** The symbol, else the description, as the file writes it. */
  label: string;
  reason: string;
}

export interface PositionsFile {
  layout: PositionsLayoutId;
  positions: FilePosition[];
  skipped: SkippedFileRow[];
}

export class PositionsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PositionsFileError";
  }
}

/** The reasons a row is skipped, as they are shown. */
export const SKIP_REASONS = {
  cash: "cash or money market",
  pending: "pending activity",
  option: "option",
  bond: "bond or CD",
  noTicker: "no ticker in the file",
  notSymbol: "not a ticker symbol",
  noShares: "no share count",
  zero: "no shares held",
  netZero: "rows net to zero shares",
  currencies: "rows in different currencies",
} as const;

type Role =
  | "symbol" | "description" | "quantity" | "costTotal" | "costPerShare" | "date"
  | "currency" | "securityType" | "value" | "gain" | "cusip";

/** Header names each column goes by, lower case, with units ($, #, ($)) taken off. */
const ROLE_NAMES: Readonly<Record<Role, readonly string[]>> = {
  symbol: ["symbol", "ticker", "ticker symbol", "symbol/cusip", "security symbol", "stock symbol", "trading symbol"],
  description: [
    "description", "security description", "investment name", "investment", "name", "security name", "fund name",
    "fund", "holding", "holding name", "asset name", "company", "company name",
  ],
  quantity: [
    "quantity", "qty", "shares", "units", "share quantity", "quantity held", "shares held", "shares/units",
    "units held", "share balance", "shares owned", "number of shares", "no. of shares",
  ],
  costTotal: [
    "cost basis total", "cost basis", "total cost basis", "total cost", "cost", "book value", "book cost",
    "adjusted cost basis", "adjusted cost", "cost basis amount", "purchase value", "amount invested",
  ],
  costPerShare: [
    "average cost basis", "avg cost basis", "average cost", "avg cost", "avg. cost", "average price", "avg price",
    "average cost per share", "avg cost/share", "cost per share", "cost/share", "cost per unit", "unit cost",
    "average unit cost", "price paid", "purchase price", "buy price", "entry price",
  ],
  date: [
    "date acquired", "acquired", "acquisition date", "acquired date", "acquired on", "purchase date",
    "date purchased", "open date", "date opened", "trade date", "date",
  ],
  currency: ["currency", "ccy", "cost currency", "position currency", "trading currency", "price currency"],
  securityType: [
    "security type", "asset type", "asset class", "security class", "investment type", "product type",
    "asset category", "instrument type",
  ],
  value: ["current value", "market value", "mkt val", "market val", "value", "total value", "ending value", "position value"],
  gain: [
    "unrealized gain/loss", "unrealized gain/loss dollar", "total gain/loss dollar", "total gain/loss", "gain/loss",
    "gain/loss dollar", "gain", "total gain", "unrealized gain", "unrealized p&l", "unrealized p/l",
  ],
  cusip: ["cusip", "cusip number"],
};

const ROLES = Object.keys(ROLE_NAMES) as Role[];

/** Columns of an activity export (trades, dividends, transfers): its rows are not holdings. */
const ACTIVITY_COLUMN = /transaction|^action$|^activity$|^settlement date$|^process date$|^run date$/;

/** The broker exports' default currency: their positions are in US dollars. */
const US_LAYOUTS: ReadonlySet<PositionsLayoutId> = new Set(["fidelity", "schwab", "vanguard", "etrade", "merrill"]);

const TOTAL_ROW = /^(?:account|grand|positions|portfolio|overall)?\s*totals?\b|\btotals?:?$/i;
const PENDING_ROW = /^pending\b/i;
const CASH_SYMBOL = /^(?:cash|cash & cash investments|cash and cash investments|cash & money market|cash and money market|money market|money market funds?|core position|cash balance|sweep|bank sweep|fcash)$/i;
const CASH_TYPE = /^(?:cash|cash and money market|cash & money market|money market|sweep)\b/i;
const CASH_DESCRIPTION = /money market|cash reserves|held in money market|bank deposit|deposit program|deposit sweep|sweep program|insured deposit/i;
/** Fidelity ` -AAPL250117C200`, the OCC `AAPL  250117C00200000`, Schwab `AAPL 01/17/2025 200.00 C`, E*TRADE `AAPL Jan 17 '25 $200 Call`. */
const OPTION_SYMBOLS = [
  /^-?[A-Z]{1,6}\d{6}[CP]\d+(?:\.\d+)?$/,
  /^[A-Z]{1,6}\s*\d{6}[CP]\d{8}$/,
  /^[A-Z./]{1,8} \d{1,2}\/\d{1,2}\/\d{2,4} \$?\d+(?:\.\d+)? [CP]$/,
  /^[A-Z./]{1,8} [A-Z]{3} \d{1,2} '?\d{2,4} \$?\d+(?:\.\d+)? (?:CALL|PUT)$/,
];
const OPTION_TYPE = /\boptions?\b/i;
const BOND_TYPE = /^(?:fixed income|bonds?|treasur(?:y|ies)|cds?|certificates? of deposit|brokered cds?|municipal(?: bonds?)?|corporate bonds?|government bonds?|agency bonds?)\b/i;
/** A CUSIP where a ticker should be: a security with no ticker, which a broker's export means a bond or CD. */
const CUSIP = /^[0-9]{3}[0-9A-Z]{5}[0-9]$/;
const SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^:]{0,19}$/;

function headerNames(cell: string): string[] {
  const raw = cell.replace(/\s+/g, " ").trim().toLowerCase();
  // A percent column (Gain %) is never a share count, a cost or a value.
  if (!raw || raw.includes("%")) return [];
  const names = new Set<string>();
  const add = (value: string | undefined) => {
    const name = (value ?? "").replace(/\(\s*[$#]\s*\)/g, "").replace(/[$#*:]/g, "").replace(/\s+/g, " ").trim();
    if (name) names.add(name);
  };
  add(raw);
  // Schwab: "Qty (Quantity)", "Mkt Val (Market Value)".
  const paren = /^(.*?)\((.*)\)\s*$/.exec(raw);
  if (paren) {
    add(paren[1]);
    add(paren[2]);
  }
  return [...names];
}

interface Header {
  columns: Partial<Record<Role, number>>;
  /** Every name the header's cells go by, for telling the layouts apart. */
  names: Set<string>;
  activity: boolean;
}

function readHeader(cells: readonly string[]): Header | null {
  const filled = cells.filter((cell) => cell.trim());
  if (filled.length < 2 || filled.some((cell) => readNumber(cell, false) !== null)) return null;
  const columns: Partial<Record<Role, number>> = {};
  const names = new Set<string>();
  cells.forEach((cell, index) => {
    const cellNames = headerNames(cell);
    for (const name of cellNames) names.add(name);
    for (const role of ROLES) {
      if (columns[role] === undefined && cellNames.some((name) => ROLE_NAMES[role].includes(name))) {
        columns[role] = index;
        break;
      }
    }
  });
  // An activity table starts a section of its own, so its rows never read as holdings of the table above it.
  if (filled.length >= 3 && [...names].some((name) => ACTIVITY_COLUMN.test(name))) return { columns, names, activity: true };
  const holdings = (columns.symbol !== undefined || columns.description !== undefined) && columns.quantity !== undefined;
  return holdings ? { columns, names, activity: false } : null;
}

function layoutOf(names: ReadonlySet<string>, schwabTitle: boolean): PositionsLayoutId {
  const has = (name: string) => names.has(name);
  if (has("account number") && has("last price") && has("current value")) return "fidelity";
  if (has("investment name") && has("share price") && has("total value")) return "vanguard";
  if (has("price paid") && has("last price")) return "etrade";
  if (has("cob date") || (has("security description") && has("cusip") && has("account registration"))) return "merrill";
  if (schwabTitle || (has("security type") && (has("mkt val") || has("market value")) && has("cost basis"))) return "schwab";
  return "generic";
}

interface CsvRecord {
  line: number;
  cells: string[];
}

/** RFC 4180 records: quoted cells may hold the delimiter, doubled quotes and line breaks. */
function readRecords(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const endCell = () => {
    cells.push(cell.trim());
    cell = "";
  };
  const endRecord = () => {
    endCell();
    records.push({ line: start, cells });
    cells = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === delimiter) {
      endCell();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      start = line;
    } else {
      cell += char;
    }
  }
  if (cell || cells.length > 0) endRecord();
  return records;
}

/**
 * A number as the exports write one: `$1,234.56`, `+$1.14`, `-$2.97`,
 * `(1,234.56)`, `1,000`; with a decimal comma, `1.234,56`. Null for `--`,
 * `n/a`, `Incomplete` and anything else that is not a number.
 */
function readNumber(text: string, decimalComma: boolean): number | null {
  let value = text.trim();
  if (!value) return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/[$€£¥\s]/g, "");
  if (value.startsWith("+")) value = value.slice(1);
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  }
  if (decimalComma) {
    if (!/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$|^\d*(?:,\d+)?$/.test(value)) return null;
    value = value.replace(/\./g, "").replace(",", ".");
  } else {
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$|^\d*\.?\d*$/.test(value)) return null;
    value = value.replace(/,/g, "");
  }
  if (!/\d/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

/**
 * A purchase date as YYYY-MM-DD. The US exports write the month first
 * (1/15/2025), which a day over 12 corrects (15/1/2025). A day after today
 * is no purchase date.
 */
function readFileDate(text: string, now: Date): string | null {
  const value = text.trim().split(/\s+(?=\d{1,2}:\d{2})/)[0] ?? "";
  if (!value) return null;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  let date: string | null;
  if (slashed) {
    const [first, second] = [Number(slashed[1]), Number(slashed[2])];
    const year = slashed[3]!.length === 2 ? 2000 + Number(slashed[3]) : Number(slashed[3]);
    const [month, day] = first > 12 ? [second, first] : [first, second];
    date = readCalendarDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  } else {
    date = readCalendarDate(value);
  }
  return date && date <= now.toISOString().slice(0, 10) ? date : null;
}

function readCurrency(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const code = normalizeHeldCurrencyCode(raw);
  // Pence (GBp, GBX) are a unit of the pound, kept as the file writes them.
  if (resolveCurrencyUnit(code).divisor !== 1) return code;
  return /^[A-Z]{3}$/.test(code) && isCurrencyCode(code) ? code : null;
}

/** The symbol cleaned of the marks exports add: Fidelity's `**` core money market, Schwab's `BRK/B`. */
function cleanSymbol(text: string): string {
  const symbol = text.trim().replace(/\*+$/, "").toUpperCase();
  if (!symbol || /^-+$/.test(symbol) || /^n\/?a$/i.test(symbol)) return "";
  return symbol.replace(/\//g, ".");
}

interface ReadRow {
  line: number;
  symbol: string;
  description: string | null;
  shares: number;
  avgCost: number | null;
  currency: string | null;
  dateAcquired: string | null;
}

type RowReading = { kind: "position"; row: ReadRow } | { kind: "skipped"; skipped: SkippedFileRow } | { kind: "ignored" };

function readRow(
  record: CsvRecord,
  header: Header,
  options: { decimalComma: boolean; defaultCurrency: string | null; now: Date },
): RowReading {
  const { cells, line } = record;
  const cell = (role: Role) => {
    const index = header.columns[role];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const filled = cells.filter((value) => value.trim() && !/^-+$/.test(value.trim()));
  // Blank rows, account titles ("Individual ...321") and footers fill one cell at most.
  if (filled.length < 2) return { kind: "ignored" };
  const rawSymbol = cell("symbol");
  const description = cell("description") || null;
  const type = cell("securityType");
  const lead = rawSymbol || filled[0]!.trim();
  if (TOTAL_ROW.test(lead) || (!rawSymbol && description && TOTAL_ROW.test(description))) return { kind: "ignored" };
  const label = (cleanSymbol(rawSymbol) ? rawSymbol : description) || lead;
  const skip = (reason: string): RowReading => ({ kind: "skipped", skipped: { line, label, reason } });
  if (PENDING_ROW.test(rawSymbol) || (!rawSymbol && description && PENDING_ROW.test(description))) return skip(SKIP_REASONS.pending);
  const upper = rawSymbol.trim().toUpperCase();
  if (/\*\*$/.test(rawSymbol) || CASH_SYMBOL.test(rawSymbol) || CASH_TYPE.test(type) || (description && CASH_DESCRIPTION.test(description))) {
    return skip(SKIP_REASONS.cash);
  }
  if (OPTION_TYPE.test(type) || OPTION_SYMBOLS.some((pattern) => pattern.test(upper))
    || (description && /\b(?:call|put)\b/i.test(description) && /\d/.test(upper) && upper.length > 6)) {
    return skip(SKIP_REASONS.option);
  }
  const symbol = cleanSymbol(rawSymbol);
  const coupon = !!description && /\d(?:\.\d+)?\s*%/.test(description) && /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(description);
  if (BOND_TYPE.test(type) || CUSIP.test(symbol) || (!symbol && coupon)) return skip(SKIP_REASONS.bond);
  if (!symbol) return skip(SKIP_REASONS.noTicker);
  if (!SYMBOL.test(symbol)) return skip(SKIP_REASONS.notSymbol);
  const shares = readNumber(cell("quantity"), options.decimalComma);
  if (shares === null) return skip(SKIP_REASONS.noShares);
  if (shares === 0) return skip(SKIP_REASONS.zero);
  const magnitude = Math.abs(shares);
  const perShare = readNumber(cell("costPerShare"), options.decimalComma);
  const total = readNumber(cell("costTotal"), options.decimalComma);
  const value = readNumber(cell("value"), options.decimalComma);
  const gain = readNumber(cell("gain"), options.decimalComma);
  // Merrill gives no cost column: the cost is the value less the unrealized gain.
  const avgCost = perShare !== null && perShare !== 0 ? Math.abs(perShare)
    : total !== null && total !== 0 ? tidy(Math.abs(total) / magnitude)
      : value !== null && gain !== null && value - gain !== 0 ? tidy(Math.abs(value - gain) / magnitude)
        : null;
  return {
    kind: "position",
    row: {
      line,
      symbol,
      description,
      shares,
      avgCost,
      currency: readCurrency(cell("currency")) ?? options.defaultCurrency,
      dateAcquired: readFileDate(cell("date"), options.now),
    },
  };
}

/** Drops the float noise of a sum (0.1 + 0.2) without losing a digit the file wrote. */
function tidy(value: number): number {
  return Number(value.toPrecision(15));
}

/** Several accounts or lots of one symbol are one position: shares added up, cost by shares, the earliest date. */
function mergeRows(rows: readonly ReadRow[]): { position: FilePosition } | { skipped: SkippedFileRow[] } {
  const first = rows[0]!;
  const skipAll = (reason: string) => ({ skipped: rows.map((row) => ({ line: row.line, label: row.symbol, reason })) });
  const currencies = new Set(rows.map((row) => row.currency ?? ""));
  if (currencies.size > 1) return skipAll(`${SKIP_REASONS.currencies} (${[...currencies].map((code) => code || "none").join(", ")})`);
  const shares = tidy(rows.reduce((sum, row) => sum + row.shares, 0));
  if (shares === 0) return skipAll(SKIP_REASONS.netZero);
  const held = rows.reduce((sum, row) => sum + Math.abs(row.shares), 0);
  const costed = rows.every((row) => row.avgCost !== null);
  const avgCost = rows.length === 1 ? first.avgCost
    : costed ? tidy(rows.reduce((sum, row) => sum + row.avgCost! * Math.abs(row.shares), 0) / held) : null;
  const dates = rows.map((row) => row.dateAcquired).filter((date): date is string => !!date).sort();
  return {
    position: {
      symbol: first.symbol,
      description: rows.find((row) => row.description)?.description ?? null,
      shares,
      avgCost,
      currency: first.currency,
      dateAcquired: dates[0] ?? null,
      lines: rows.map((row) => row.line),
    },
  };
}

interface Section {
  header: Header;
  records: CsvRecord[];
}

function readSections(records: readonly CsvRecord[]): { sections: Section[]; schwabTitle: boolean } {
  const sections: Section[] = [];
  let schwabTitle = false;
  let current: Section | null = null;
  for (const record of records) {
    if (/^positions for\b/i.test(record.cells[0] ?? "")) schwabTitle = true;
    const header = readHeader(record.cells);
    if (header) {
      current = { header, records: [] };
      sections.push(current);
      continue;
    }
    current?.records.push(record);
  }
  return { sections, schwabTitle };
}

function pickDelimiter(text: string): { delimiter: string; records: CsvRecord[] } {
  let fallback: { delimiter: string; records: CsvRecord[] } | null = null;
  for (const delimiter of [",", "\t", ";"]) {
    const records = readRecords(text, delimiter);
    fallback ??= { delimiter, records };
    if (records.some((record) => readHeader(record.cells))) return { delimiter, records };
  }
  return fallback!;
}

/** Whether a file split by something other than commas writes its numbers with a decimal comma (1.234,56). */
function usesDecimalComma(delimiter: string, sections: readonly Section[]): boolean {
  if (delimiter === ",") return false;
  return sections.some((section) => section.records.some((record) => record.cells.some((cell) =>
    /^[-+]?[$€£]?\s?\d{1,3}(?:\.\d{3})*,\d+$/.test(cell.trim()))));
}

/**
 * The positions a broker's export lists, and the rows it names that are not
 * imported with the reason. Throws `PositionsFileError` when the file has no
 * positions table: no header row with a symbol (or a fund name) and a share
 * count, or only an activity history.
 */
export function parsePositionsFile(text: string, now = new Date()): PositionsFile {
  const { delimiter, records } = pickDelimiter(text.replace(/^\uFEFF/, ""));
  const { sections, schwabTitle } = readSections(records);
  const holdings = sections.filter((section) => !section.header.activity);
  if (holdings.length === 0) {
    throw new PositionsFileError(sections.length > 0
      ? "This is an activity history (trades and transfers), not a positions export. Download the positions or holdings page instead."
      : "No positions table found: the file needs a header row with a Symbol (or Ticker) column and a Quantity (or Shares) column.");
  }
  const layout = layoutOf(holdings[0]!.header.names, schwabTitle);
  const options = {
    decimalComma: usesDecimalComma(delimiter, holdings),
    defaultCurrency: US_LAYOUTS.has(layout) ? "USD" : null,
    now,
  };
  const skipped: SkippedFileRow[] = [];
  const bySymbol = new Map<string, ReadRow[]>();
  for (const section of holdings) {
    for (const record of section.records) {
      const reading = readRow(record, section.header, options);
      if (reading.kind === "skipped") skipped.push(reading.skipped);
      if (reading.kind !== "position") continue;
      const rows = bySymbol.get(reading.row.symbol) ?? [];
      rows.push(reading.row);
      bySymbol.set(reading.row.symbol, rows);
    }
  }
  const positions: FilePosition[] = [];
  for (const rows of bySymbol.values()) {
    const merged = mergeRows(rows);
    if ("position" in merged) positions.push(merged.position);
    else skipped.push(...merged.skipped);
  }
  if (positions.length === 0 && skipped.length === 0) throw new PositionsFileError("The positions table has no rows.");
  skipped.sort((left, right) => left.line - right.line);
  return { layout, positions, skipped };
}
