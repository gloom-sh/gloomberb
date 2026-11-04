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

/** Why a row is not imported: one of `SKIP_REASONS`, or a symbol that did not resolve to a listing. */
export type SkipKind = keyof typeof SKIP_REASONS | "lookup";

/** A row that names something but is not imported, and why. */
export interface SkippedFileRow {
  line: number;
  /** The symbol, else the description, as the file writes it. */
  label: string;
  reason: string;
  kind: SkipKind;
  /** The row's symbol, cleaned, when it has one: a holding of it is never removed by a replace. */
  symbol: string | null;
}

export interface PositionsFile {
  layout: PositionsLayoutId;
  positions: FilePosition[];
  skipped: SkippedFileRow[];
}

/** Why a file has no positions to import: no positions table, only activity, too many positions, or none. */
export type PositionsFileProblem = "no-table" | "activity" | "too-many" | "empty";

export class PositionsFileError extends Error {
  constructor(message: string, readonly problem: PositionsFileProblem) {
    super(message);
    this.name = "PositionsFileError";
  }
}

/** The largest export read: a brokerage's positions file is kilobytes, so anything bigger is the wrong file. */
export const MAX_POSITIONS_FILE_BYTES = 5 * 1024 * 1024;

/** The most positions one import takes: every symbol is looked up, and the preview lists each. */
export const MAX_IMPORT_POSITIONS = 1000;

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
const ACTIVITY_COLUMN = /transaction|^trans code$|^action$|^activity$|^side$|^buy\/sell$|^b\/s$|^trade type$|^order type$|^settlement date$|^process date$|^run date$/;
/** A plain Type column is a trade's side in a trade history, and a holding's account type (Cash, Margin) in Fidelity's positions. */
const TYPE_COLUMN = new Set(["type", "kind"]);
/** A trade's side or an activity's kind. Not Short: Fidelity's Type says a holding is short. */
const TRADE_SIDE = /^(?:buy|sell|bought|sold|you bought|you sold|b|s|buy to (?:open|close|cover)|sell (?:short|to (?:open|close))|short sell|dividend|reinvest(?:ment)?|interest|deposit|withdrawal|transfer)$/i;

/** The broker exports' default currency: their positions are in US dollars. */
const US_LAYOUTS: ReadonlySet<PositionsLayoutId> = new Set(["fidelity", "schwab", "vanguard", "etrade", "merrill"]);

/** A US brokerage's export, whose accounts hold US listings in US dollars. */
export function isUsBrokerLayout(layout: PositionsLayoutId): boolean {
  return US_LAYOUTS.has(layout);
}

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
/** A symbol cell with nothing else on its row, read as a ticker only when written as one: upper case and short. */
const LONE_TICKER = /^[A-Z][A-Z0-9.\-/]{0,9}$/;

/**
 * The longest cell each reading looks at. A file can hold anything; past
 * these lengths a cell is no column name, number, date or ticker, and is not
 * searched, so no cell costs more than its length.
 */
const MAX_HEADER_CELL = 80;
const MAX_NUMBER_CELL = 40;
const MAX_SYMBOL_CELL = 40;
const MAX_LABEL = 60;

function clip(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1).trimEnd()}…` : text;
}

function headerNames(cell: string): string[] {
  if (cell.length > MAX_HEADER_CELL) return [];
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
  /** A plain Type column, which makes the table a trade history when it holds buys and sells. */
  typeColumn: number | null;
}

/**
 * Each role's column is the one with its most specific name, wherever it
 * stands: Trade Date before Date, Average Cost before Cost. A column serves
 * one role.
 */
function assignRoles(cellNames: readonly (readonly string[])[]): Partial<Record<Role, number>> {
  const columns: Partial<Record<Role, number>> = {};
  const taken = new Set<number>();
  for (const role of ROLES) {
    let best = -1;
    let bestRank = Infinity;
    for (let index = 0; index < cellNames.length; index += 1) {
      if (taken.has(index)) continue;
      for (const name of cellNames[index]!) {
        const rank = ROLE_NAMES[role].indexOf(name);
        if (rank >= 0 && rank < bestRank) {
          best = index;
          bestRank = rank;
        }
      }
    }
    if (best >= 0) {
      columns[role] = best;
      taken.add(best);
    }
  }
  return columns;
}

function readHeader(cells: readonly string[]): Header | null {
  const filled = cells.filter((cell) => cell.trim());
  if (filled.length < 2 || filled.some((cell) => readNumber(cell, false) !== null)) return null;
  const cellNames = cells.map(headerNames);
  const names = new Set(cellNames.flat());
  const columns = assignRoles(cellNames);
  const typeIndex = cellNames.findIndex((list) => list.some((name) => TYPE_COLUMN.has(name)));
  const typeColumn = typeIndex >= 0 ? typeIndex : null;
  // An activity table starts a section of its own, so its rows never read as holdings of the table above it.
  if (filled.length >= 3 && [...names].some((name) => ACTIVITY_COLUMN.test(name))) return { columns, names, activity: true, typeColumn };
  const holdings = (columns.symbol !== undefined || columns.description !== undefined) && columns.quantity !== undefined;
  return holdings ? { columns, names, activity: false, typeColumn } : null;
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
  if (text.length > MAX_NUMBER_CELL) return null;
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

/** No date is longer: a longer cell is not one, and is not searched. */
const MAX_DATE_CELL = 40;
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

/**
 * A purchase date as YYYY-MM-DD. A slashed date is read month first
 * (1/15/2025) or, in a file that writes the day first, day first
 * (15/1/2025); a part over 12 says which it is either way. A day after today
 * is no purchase date.
 */
function readFileDate(text: string, now: Date, dayFirst: boolean): string | null {
  if (text.length > MAX_DATE_CELL) return null;
  const value = text.trim().split(/\s+(?=\d{1,2}:\d{2})/)[0] ?? "";
  if (!value) return null;
  const slashed = SLASHED_DATE.exec(value);
  let date: string | null;
  if (slashed) {
    const [first, second] = [Number(slashed[1]), Number(slashed[2])];
    const year = slashed[3]!.length === 2 ? 2000 + Number(slashed[3]) : Number(slashed[3]);
    const [month, day] = first > 12 || (dayFirst && second <= 12) ? [second, first] : [first, second];
    date = readCalendarDate(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  } else {
    date = readCalendarDate(value);
  }
  return date && date <= now.toISOString().slice(0, 10) ? date : null;
}

function readCurrency(text: string): string | null {
  const raw = text.trim();
  if (!raw || raw.length > 8) return null;
  const code = normalizeHeldCurrencyCode(raw);
  // Pence (GBp, GBX) are a unit of the pound, kept as the file writes them.
  if (resolveCurrencyUnit(code).divisor !== 1) return code;
  return /^[A-Z]{3}$/.test(code) && isCurrencyCode(code) ? code : null;
}

/** The symbol cleaned of the marks exports add: Fidelity's `**` core money market, Schwab's `BRK/B`. */
function cleanSymbol(text: string): string {
  // Too long for a ticker: kept as written, so it is skipped as not one.
  if (text.length > MAX_SYMBOL_CELL) return text.trim().toUpperCase();
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

interface RowOptions {
  decimalComma: boolean;
  dayFirst: boolean;
  defaultCurrency: string | null;
  now: Date;
}

function readRow(record: CsvRecord, header: Header, options: RowOptions): RowReading {
  const { cells, line } = record;
  const cell = (role: Role) => {
    const index = header.columns[role];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };
  const filled = cells.filter((value) => value.trim() && !/^-+$/.test(value.trim()));
  const rawSymbol = cell("symbol");
  // Blank rows, account titles ("Individual ...321") and footers fill one cell at most. A ticker
  // alone (KO with -- for its shares) is a holding the file could not count, skipped as one.
  if (filled.length < 2 && !(filled.length === 1 && filled[0] === rawSymbol && LONE_TICKER.test(rawSymbol))) return { kind: "ignored" };
  const description = cell("description") || null;
  const type = cell("securityType");
  const lead = rawSymbol || filled[0]!.trim();
  if (TOTAL_ROW.test(lead) || (!rawSymbol && description && TOTAL_ROW.test(description))) return { kind: "ignored" };
  const symbol = cleanSymbol(rawSymbol);
  const label = clip((symbol ? rawSymbol : description) || lead);
  const skip = (kind: keyof typeof SKIP_REASONS): RowReading => ({
    kind: "skipped",
    skipped: { line, label, reason: SKIP_REASONS[kind], kind, symbol: symbol && symbol.length <= MAX_SYMBOL_CELL ? symbol : null },
  });
  if (PENDING_ROW.test(rawSymbol) || (!rawSymbol && description && PENDING_ROW.test(description))) return skip("pending");
  const upper = rawSymbol.trim().toUpperCase();
  if (/\*\*$/.test(rawSymbol) || CASH_SYMBOL.test(rawSymbol) || CASH_TYPE.test(type) || (description && CASH_DESCRIPTION.test(description))) {
    return skip("cash");
  }
  if (OPTION_TYPE.test(type) || OPTION_SYMBOLS.some((pattern) => pattern.test(upper))
    || (description && /\b(?:call|put)\b/i.test(description) && /\d/.test(upper) && upper.length > 6)) {
    return skip("option");
  }
  const coupon = !!description && /\d(?:\.\d+)?\s*%/.test(description) && /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(description);
  if (BOND_TYPE.test(type) || CUSIP.test(symbol) || (!symbol && coupon)) return skip("bond");
  if (!symbol) return skip("noTicker");
  if (!SYMBOL.test(symbol)) return skip("notSymbol");
  const shares = readNumber(cell("quantity"), options.decimalComma);
  if (shares === null) return skip("noShares");
  if (shares === 0) return skip("zero");
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
      dateAcquired: readFileDate(cell("date"), options.now, options.dayFirst),
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
  const skipAll = (kind: SkipKind, reason: string) => ({
    skipped: rows.map((row) => ({ line: row.line, label: row.symbol, reason, kind, symbol: row.symbol })),
  });
  const currencies = new Set(rows.map((row) => row.currency ?? ""));
  if (currencies.size > 1) return skipAll("currencies", `${SKIP_REASONS.currencies} (${[...currencies].map((code) => code || "none").join(", ")})`);
  const shares = tidy(rows.reduce((sum, row) => sum + row.shares, 0));
  if (shares === 0) return skipAll("netZero", SKIP_REASONS.netZero);
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

const NUMBER_ROLES: readonly Role[] = ["quantity", "costTotal", "costPerShare", "value", "gain"];
/** Numbers only a decimal comma reads: 12,5, 0,125, 1,2345, 1.234,56, 1.234.567. */
const DECIMAL_COMMA_ONLY = /^\d+,\d{1,2}$|^0,\d+$|^\d+,\d{4,}$|^\d{1,3}(?:\.\d{3})+,\d+$|^\d{1,3}(?:\.\d{3}){2,}$/;
/** Numbers only a decimal point reads: 12.5, 0.125, 1.2345, 1,234.56, 1,234,567. */
const DECIMAL_POINT_ONLY = /^\d*\.\d{1,2}$|^0\.\d+$|^\d*\.\d{4,}$|^\d{1,3}(?:,\d{3})+\.\d+$|^\d{1,3}(?:,\d{3}){2,}$/;

function numberBody(cell: string): string {
  return cell.trim().replace(/^\((.*)\)$/, "$1").replace(/[$€£¥\s]/g, "").replace(/^[+-]/, "");
}

/**
 * Whether a file split by tabs or semicolons writes its numbers with a
 * decimal comma (1.234,56). Only a number no decimal point could mean says
 * so: 1,500 is read as fifteen hundred, as a US export means it, unless the
 * file also writes 12,5 or 1.234,56 and never 12.50.
 */
function usesDecimalComma(delimiter: string, sections: readonly Section[]): boolean {
  if (delimiter === ",") return false;
  let comma = false;
  for (const section of sections) {
    const indexes = NUMBER_ROLES.flatMap((role) => section.header.columns[role] ?? []);
    for (const record of section.records) {
      for (const index of indexes) {
        const body = numberBody(record.cells[index] ?? "");
        if (!body) continue;
        if (DECIMAL_POINT_ONLY.test(body)) return false;
        if (DECIMAL_COMMA_ONLY.test(body)) comma = true;
      }
    }
  }
  return comma;
}

/**
 * Whether the file's slashed dates put the day first. A part over 12 says
 * which; a file whose dates never do follows its numbers (a decimal comma
 * writes the day first) and its currencies (a table in none of them USD).
 */
function writesDayFirst(sections: readonly Section[], decimalComma: boolean, layout: PositionsLayoutId): boolean {
  let dayFirst = false;
  let monthFirst = false;
  let usd = false;
  let otherCurrency = false;
  for (const section of sections) {
    const { date, currency } = section.header.columns;
    for (const record of section.records) {
      const slashed = date === undefined ? null : SLASHED_DATE.exec((record.cells[date] ?? "").trim().split(/\s/)[0] ?? "");
      if (slashed) {
        if (Number(slashed[1]) > 12) dayFirst = true;
        if (Number(slashed[2]) > 12) monthFirst = true;
      }
      const code = currency === undefined ? null : readCurrency(record.cells[currency] ?? "");
      if (code === "USD") usd = true;
      else if (code) otherCurrency = true;
    }
  }
  if (dayFirst !== monthFirst) return dayFirst;
  return decimalComma || (layout === "generic" && otherCurrency && !usd);
}

/** A table whose Type column holds buys and sells is a trade history, whatever its other columns. */
function listsTrades(section: Section): boolean {
  const index = section.header.typeColumn;
  if (index === null) return false;
  const values = section.records.map((record) => (record.cells[index] ?? "").trim()).filter(Boolean);
  return values.length > 0 && values.filter((value) => TRADE_SIDE.test(value)).length * 2 >= values.length;
}

/**
 * A file's bytes as text: UTF-16 by its byte order mark (Excel's Unicode
 * text) or its zero bytes, UTF-8, else Windows-1252 (Excel's CSV on Windows).
 */
export function decodePositionsFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 4 && bytes[0] !== 0 && bytes[1] === 0 && bytes[2] !== 0 && bytes[3] === 0) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] !== 0 && bytes[2] === 0 && bytes[3] !== 0) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
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
  const holdings = sections.filter((section) => !section.header.activity && !listsTrades(section));
  if (holdings.length === 0) {
    throw sections.length > 0
      ? new PositionsFileError("This is an activity history (trades and transfers), not a positions export. Download the positions or holdings page instead.", "activity")
      : new PositionsFileError("No positions table found: the file needs a header row with a Symbol (or Ticker) column and a Quantity (or Shares) column.", "no-table");
  }
  const layout = layoutOf(holdings[0]!.header.names, schwabTitle);
  const decimalComma = usesDecimalComma(delimiter, holdings);
  const options: RowOptions = {
    decimalComma,
    dayFirst: writesDayFirst(holdings, decimalComma, layout),
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
  if (bySymbol.size > MAX_IMPORT_POSITIONS) {
    throw new PositionsFileError(`The file lists ${bySymbol.size.toLocaleString("en-US")} positions, and an import takes at most ${MAX_IMPORT_POSITIONS.toLocaleString("en-US")}. Import each account's export on its own.`, "too-many");
  }
  const positions: FilePosition[] = [];
  for (const rows of bySymbol.values()) {
    const merged = mergeRows(rows);
    if ("position" in merged) positions.push(merged.position);
    else skipped.push(...merged.skipped);
  }
  if (positions.length === 0 && skipped.length === 0) throw new PositionsFileError("The positions table has no rows.", "empty");
  skipped.sort((left, right) => left.line - right.line);
  return { layout, positions, skipped };
}
