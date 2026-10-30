/**
 * `history --csv` as one fixed table, whatever the symbol, its market's state
 * or how many symbols were asked for: the prices, the bar's flag and marks,
 * a coin's or one venue's volume, then the `status` column saying why a row
 * has no figures and the five fixed columns naming what each row is. A list
 * of symbols (`history --file`) writes every symbol's bars in one long table,
 * its rows told apart by `symbol_or_series`, and a symbol that served no bars
 * as one row with only its status.
 */
import type { CliResultColumn } from "./result";
import type { HistoryRow } from "./history-rows";

/** A bar of one symbol of a list, or the one row of a symbol that served none. */
export interface HistoryListRow extends HistoryRow {
  /** The listing the bar is of (`AAPL`, `000660.KS`), as `symbol_or_series` names it. */
  symbol: string;
  /** Why the symbol has no bars, as its warning says it; only on a symbol's one row with no bar. */
  status?: string;
}

type ExportedRow = Record<string, unknown>;

/** A bar's mark as an export writes it: true or false on a bar, nothing on a symbol's row with no bar. */
function barMark(key: "partial" | "filled" | "unsettled" | "roll" | "thin") {
  return (row: ExportedRow) => row.date ? row[key] === true : "";
}

/**
 * The columns of every `history` export, in this order, in every market
 * state: a bar still forming (Partial), rebuilt from hourly bars (Filled) or
 * closing before its settlement (Unsettled) is marked in its own column
 * whether or not any bar of this run has one, so files of different symbols
 * or days line up when joined.
 */
const HISTORY_EXPORT_COLUMNS: CliResultColumn<ExportedRow>[] = [
  { key: "date", header: "Date" },
  { key: "open", header: "Open" },
  { key: "high", header: "High" },
  { key: "low", header: "Low" },
  { key: "close", header: "Close" },
  { key: "volume", header: "Volume" },
  { key: "flag", header: "Flag" },
  { key: "partial", header: "Partial", value: barMark("partial") },
  { key: "filled", header: "Filled", value: barMark("filled") },
  { key: "unsettled", header: "Unsettled", value: barMark("unsettled") },
  { key: "volumeUnit", header: "Volume unit" },
  { key: "volumeNote", header: "Volume note" },
  { key: "venueVolume", header: "Venue volume" },
  { key: "volumeVenue", header: "Volume venue" },
];

/** A continuous future's contract per bar, the bar it rolled at, and a bar that traded far below those around it. */
const CONTRACT_EXPORT_COLUMNS: CliResultColumn<ExportedRow>[] = [
  { key: "contract", header: "Contract" },
  { key: "roll", header: "Roll", value: barMark("roll") },
  { key: "thin", header: "Thin", value: barMark("thin") },
];

/**
 * The columns of an export of these rows: HISTORY_EXPORT_COLUMNS, and when a
 * bar names its contract (a continuous future such as NG=F) Contract, Roll and
 * Thin after them, for every row of the export. A stock's or a coin's file is
 * as it always was.
 */
export function historyExportColumns(rows: readonly Pick<HistoryRow, "contract">[]): CliResultColumn<ExportedRow>[] {
  return rows.some((row) => typeof row.contract === "string" && row.contract !== "")
    ? [...HISTORY_EXPORT_COLUMNS, ...CONTRACT_EXPORT_COLUMNS]
    : HISTORY_EXPORT_COLUMNS;
}

/** Flags of a break before a bar, whose prices stay; every other code left the prices blank. */
const BREAK_FLAGS = new Set(["gap", "jump"]);

/**
 * Why an exported history row has no prices: the symbol's failure, or the
 * contradiction its source's prices had (`prices left blank: high<open`).
 * Empty for a bar with its prices.
 */
export function historyExportStatus(row: ExportedRow): string {
  if (typeof row.status === "string" && row.status) return row.status;
  const blanked = [row.open, row.high, row.low, row.close].every((value) => value == null);
  const codes = (typeof row.flag === "string" ? row.flag : "").split(",").filter((code) => code && !BREAK_FLAGS.has(code));
  return row.date && blanked && codes.length > 0 ? `prices left blank: ${codes.join(",")}` : "";
}

/** The one row a symbol that served no bars exports: its symbol and why, every figure empty. */
export function historyFailureRow(symbol: string, status: string): HistoryListRow {
  return {
    symbol, date: "", open: null, high: null, low: null, close: null, volume: null,
    currency: null, unit: null, interval: null, flag: null, status,
  };
}

/**
 * A symbol's failure in one line, for its status cell and warning: the
 * message, and the listings its details offer to choose between, as `quote`
 * says it (`Choose an exchange for FP. Listings: FP:NEO, FP:TSXV.`).
 */
export function oneLineFailure(message: string, details: unknown): string {
  if (typeof details !== "string") return message;
  const lines = details.split("\n");
  const heading = lines.findIndex((line) => /^\S.*:$/.test(line));
  if (heading < 0) return message;
  const listings = lines.slice(heading + 1).flatMap((line) => /^\s+([^\s(]+)\s/.exec(line)?.[1] ?? []);
  return listings.length > 0 ? `${message} ${lines[heading]} ${listings.join(", ")}.` : message;
}

/** At most this many symbols are named before a shared warning counts the rest. */
const NAMED_SYMBOLS = 8;

function symbolList(symbols: readonly string[]): string {
  if (symbols.length <= NAMED_SYMBOLS) return symbols.join(", ");
  return `${symbols.slice(0, NAMED_SYMBOLS).join(", ")} and ${symbols.length - NAMED_SYMBOLS} more`;
}

/**
 * Whether a warning names a symbol as a whole word, in the case symbols are
 * written in: `F` is named in "Not a ticker: F." but not in "AAPL, FB". A
 * one-letter symbol is also an article that opens a sentence ("A gap of ..."),
 * so it counts only where prose would not put one.
 */
function namesSymbol(note: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const after = symbol.length === 1 ? "(?![A-Za-z0-9]|\\s+[a-z])" : "(?![A-Za-z0-9])";
  return new RegExp(`(?<![A-Za-z0-9])${escaped}${after}`).test(note);
}

/**
 * The warnings of a list of symbols, each said once with the symbols it is
 * about (`AAPL, MSFT: 2026-10-23 is still forming (partial)`), in the order
 * they first came up. A warning that already names its symbol, as `Not a
 * ticker: ZZZZQQ.` does, stands alone.
 */
export function symbolListNotes(entries: ReadonlyArray<{ symbol: string; notes: readonly string[] }>): string[] {
  const bySymbol = new Map<string, string[]>();
  for (const { symbol, notes } of entries) {
    for (const note of notes) {
      const symbols = bySymbol.get(note) ?? [];
      if (!symbols.includes(symbol)) bySymbol.set(note, [...symbols, symbol]);
    }
  }
  return [...bySymbol].map(([note, symbols]) => (
    symbols.length === 1 && namesSymbol(note, symbols[0]!) ? note : `${symbolList(symbols)}: ${note}`
  ));
}
