import { readFile } from "fs/promises";
import { fstatSync } from "fs";
import { splitSymbolArgLines, splitSymbolWords, stripStrayEdges, uniqueSymbols } from "./symbol-args";
import { hasDecimalCommas, isFigure, isJunkCell, isNumberCell, protectFigureCommas, restoreFigureCommas } from "./symbol-cells";

/** Header cells that name a spreadsheet's symbol column, compared without case, spaces or punctuation. */
const SYMBOL_HEADERS = new Set(["symbol", "symbols", "ticker", "tickers", "code", "stockcode", "securitycode", "instrument"]);
/** A header naming a column of company names, read when no column names the symbols. */
const NAME_HEADERS = new Set(["name", "names", "company", "companies", "companyname", "security", "securityname", "issuer", "issuername"]);

/** One symbol as it can be typed: AAPL, $nvda, TTF.AS, SAN:EPA, BRK-B, 7203.T, ^GSPC, ES=F. */
const SYMBOL_TOKEN = /^\$?[\p{L}\p{N}^][\p{L}\p{N}.:\-^=/&]{0,23}$/u;

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function isComment(cell: string): boolean {
  return cell.startsWith("#") || cell.startsWith("//");
}

/** Whether a quote mark at `index` closes a quoted cell: it is followed by a separator, a line end or the end. */
function closesCell(text: string, index: number): boolean {
  return /^[^\S\n]*(?:[\t,;\n]|$)/.test(text.slice(index + 1, index + 40));
}

/** Where the quoted cell opened at `index` ends, or -1 when no quote mark closes it, so the mark is only a stray. */
function closingQuote(text: string, index: number): number {
  for (let at = text.indexOf("\"", index + 1); at >= 0; at = text.indexOf("\"", at + 1)) {
    if (text[at + 1] === "\"") {
      at += 1;
      continue;
    }
    if (closesCell(text, at)) return at;
  }
  return -1;
}

/**
 * The records of a text: its lines, except that a quoted cell (RFC 4180)
 * may hold a line break. A quote mark opens a cell only at the start of
 * one and when a mark closes it, so a stray one never swallows the lines after it.
 */
function splitRecords(text: string): string[] {
  const records: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\"" && /(?:^|[\t,;])[^\S\n]*$/.test(text.slice(start, index))) {
      const end = closingQuote(text, index);
      if (end >= 0) index = end;
    } else if (char === "\n") {
      records.push(text.slice(start, index));
      start = index + 1;
    }
  }
  records.push(text.slice(start));
  return records;
}

/**
 * The separator of one line: a tab, else a semicolon, else a comma that
 * splits cells, not one inside a figure (`ED 2.582,52` is split by its space,
 * `CNX;1.899,21` by its semicolon). Null for a line split by spaces. A
 * separator at either end is a stray (`UPST;`), named when the cell is read.
 * `decimalCommas` says whether a comma between plain digits is a decimal one.
 */
function lineDelimiter(record: string, decimalCommas: boolean): string | null {
  const bare = protectFigureCommas(record, decimalCommas).replace(/^[\s,;]+|[\s,;]+$/g, "").replace(/"(?:[^"]|"")*"/g, "");
  return ["\t", ";", ","].find((delimiter) => bare.includes(delimiter)) ?? null;
}

/** The cells of a line split by `delimiter`; a quoted cell may hold the delimiter and doubled quotes. */
function splitCells(record: string, delimiter: string, decimalCommas: boolean): string[] {
  const text = protectFigureCommas(record, decimalCommas);
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"" && !cell.trim() && closingQuote(text, index) >= 0) {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => restoreFigureCommas(value).trim());
}

/**
 * The cells of each line, each line split by its own separator
 * (`lineDelimiter`), as a list pasted from several sheets mixes them. A line
 * with no separator in a list whose other lines have one is one cell (a
 * company's name), unless a figure follows its first word (`ED 2.582,52`).
 * A comma between plain digits is a decimal comma on a line with another
 * separator, or under a header split by tabs or semicolons; otherwise it
 * splits the line (`0700,25` is a code and a weight). `delimited` says
 * whether any line had a separator.
 */
function readRecords(text: string): { records: string[][]; delimited: boolean } {
  const kept = splitRecords(text).filter((record) => record.replace(/[\s,;"']/g, ""));
  const sheetDecimals = headerSplitsOnTabsOrSemicolons(kept[0]);
  const lines = kept.map((record) => {
    const decimalCommas = sheetDecimals || hasDecimalCommas(record);
    const delimiter = lineDelimiter(record, decimalCommas);
    return delimiter
      ? { cells: splitCells(record, delimiter, decimalCommas), delimited: true }
      : { cells: record.trim().split(/\s+/), delimited: false };
  });
  const delimited = lines.some((line) => line.delimited);
  const records = lines.map(({ cells, delimited: own }) => (
    own || !delimited || cells.slice(1).some(isFigure) ? cells : [cells.join(" ")]
  ));
  return { records: records.filter((cells) => cells.some(Boolean) && !isComment(cells[0] ?? "")), delimited };
}

/** Whether a header line (one with a Symbol, Ticker, Code or Name cell) splits its cells on tabs or semicolons. */
function headerSplitsOnTabsOrSemicolons(record: string | undefined): boolean {
  if (!record) return false;
  const delimiter = lineDelimiter(record, false);
  if (delimiter !== "\t" && delimiter !== ";") return false;
  return splitCells(record, delimiter, false).map(headerKey)
    .some((key) => SYMBOL_HEADERS.has(key) || NAME_HEADERS.has(key) || key.includes("symbol") || key.includes("ticker"));
}

function looksLikeSymbol(cell: string): boolean {
  return SYMBOL_TOKEN.test(cell) && !isNumberCell(cell);
}

/** How many cells a table's ignored-cells note names before it counts the rest. */
const IGNORED_PREVIEW = 8;

/** What a file or piped text holds: its symbols in order, and the cells of a table read by one column that were left out. */
interface SymbolText {
  symbols: string[];
  /** Cells beside the symbol column of a table with no header, in reading order; empty for a list or a CSV with a header. */
  ignored: string[];
  /**
   * The symbols are a list's entries, each a line or a cell of a list split
   * by semicolons or commas, and are read as typed entries are
   * (`readNameEntries`): one with spaces is a company's name (`Altria
   * Group`), or symbols written on one line (`AAPL MSFT`).
   */
  entries?: true;
}

/**
 * The symbols in a file or piped text, in order. Each line is split by its
 * own separator (`readRecords`): a tab, a semicolon, a comma that is not a
 * decimal comma, or spaces. A figure (`2.582,52`, `1,899.21`, `12%`) is never
 * a symbol, and a bare whole number beside a symbol is a value: such a cell
 * makes the list a table. A spreadsheet export reads from the column its
 * header names (Symbol, Ticker, Code), else from its Name or Company column,
 * as `entries`. Without a header, every cell is a symbol unless some column
 * after the first holds a name, a price or a weight: that table is read by
 * its first column, and the cells beside it are returned as `ignored` so the
 * command can name them. A list split by commas, spaces or newlines gives
 * every entry, even when a line of it is ragged or carries a stray separator
 * (`"BIMAS ,"`); a cell that names nothing (`N/A`, `$$$`) does not make it a
 * table, and is refused by the lookup. A list of lines gives each line whole,
 * and a list of names split by semicolons or commas (one line, or one name a
 * line) each cell, as `entries`: a line with spaces is a company's name
 * (`Altria Group`) or symbols on one line, which reading the entries tells
 * apart. Names beside other text (`Apple Inc,Technology`) are a table read by
 * its first column, its names as `entries`. A byte order mark, Windows line
 * ends, blank lines and lines starting with # or // are ignored.
 */
export function parseSymbolText(text: string): SymbolText {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const { records, delimited } = readRecords(normalized);
  if (records.length === 0) return { symbols: [], ignored: [] };
  const header = records[0]!.map(headerKey);
  const exact = header.findIndex((cell) => SYMBOL_HEADERS.has(cell));
  const column = exact >= 0 ? exact : header.findIndex((cell) => cell.includes("symbol") || cell.includes("ticker"));
  if (column >= 0) return { symbols: records.slice(1).map((cells) => cells[column] ?? "").filter(Boolean), ignored: [] };
  // Without one, a delimited export's Name or Company column holds the companies, read as typed names are.
  const nameColumn = delimited ? header.findIndex((cell) => NAME_HEADERS.has(cell)) : -1;
  if (nameColumn >= 0) return { symbols: records.slice(1).map((cells) => cells[nameColumn] ?? "").filter(Boolean), ignored: [], entries: true };
  // A separator or quote mark stuck to a cell is dropped (and named) when it is read, so it does not make the list a table.
  const cleaned = records.map((cells) => cells.map((cell) => stripStrayEdges(cell).text));
  const figures = cleaned.some((cells) => cells.some((cell, index) => index > 0 && isFigure(cell)));
  // Lines split by spaces alone are entries, unless figures sit beside the symbols.
  if (!delimited && !figures) return { symbols: records.map((cells) => cells.join(" ")), ignored: [], entries: true };
  const grid = cleaned.every((cells) => cells.every((cell, index) => (
    !cell || isJunkCell(cell) || (looksLikeSymbol(cell) && (index === 0 || !isFigure(cell)))
  )));
  if (grid) return { symbols: records.flat().filter(Boolean), ignored: [] };
  // Names split by semicolons or commas, with no figures: one pasted line, or one name a line with a separator left
  // on it, is a list. A name beside a sector or any other text is a table, read by its first column below.
  const names = cleaned.some((cells) => /\s/.test(cells[0] ?? ""));
  if (!figures && (records.length === 1 || (names && cleaned.every((cells) => cells.filter(Boolean).length <= 1)))) {
    return { symbols: records.flat().filter(Boolean), ignored: [], entries: true };
  }
  return {
    symbols: records.map((cells) => cells[0] ?? "").filter(Boolean),
    ignored: records.flatMap((cells) => cells.slice(1)).filter(Boolean),
    // A first column of names (Apple Inc) is read as typed names are.
    ...names ? { entries: true as const } : {},
  };
}

/** Cells named in a note, split by semicolons when one of them has a comma of its own (`2.582,52; 1.899,21`). */
function listCells(cells: readonly string[]): string {
  const named = cells.slice(0, IGNORED_PREVIEW);
  const more = cells.length - IGNORED_PREVIEW;
  return `${named.join(named.some((cell) => cell.includes(",")) ? "; " : ", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** "the cell", "the 3 number cells": number when every one is a figure. */
function cellsNoun(cells: readonly string[]): string {
  const kind = cells.every(isFigure) ? "number cell" : "cell";
  return cells.length === 1 ? `the ${kind}` : `the ${cells.length} ${kind}s`;
}

/**
 * The note a table read by its first column gets, naming what was left out:
 * `Read the first column as symbols; ignored the 4 cells beside it: Apple
 * Inc., 336.64, Microsoft, 535.07.` Long tables name the first few and count
 * the rest. Null when nothing was ignored.
 */
function ignoredCellsNote(ignored: readonly string[]): string | null {
  if (ignored.length === 0) return null;
  return `Read the first column as symbols; ignored ${cellsNoun(ignored)} beside it: ${listCells(ignored)}.`;
}

/**
 * The one note for the numbers read where a symbol goes, typed beside a
 * symbol (`ED 2.582,52`) or on a line of their own: `Ignored 3 numbers, not
 * symbols: 2.582,52; 1.899,21; 3.594,10.`
 */
function ignoredNumbersNote(numbers: readonly string[]): string | null {
  if (numbers.length === 0) return null;
  return numbers.length === 1
    ? `Ignored ${numbers[0]}, a number, not a symbol.`
    : `Ignored ${numbers.length} numbers, not symbols: ${listCells(numbers)}.`;
}

/**
 * The entries of one line of what was typed, with the figures beside its
 * symbols moved to `beside`: a number (`2.582,52`) on a line that has a
 * symbol, and a bare whole number after a symbol when only figures follow it
 * (`ED 2582`, `AAPL 150`). A bare whole number among symbols, or alone, is a
 * code (`amd 2222 pltr`, `7203`).
 */
function withoutFigures(words: readonly string[], beside: string[]): string[] {
  const symbolAt = words.findIndex((word) => !isFigure(word) && !isJunkCell(word));
  if (symbolAt < 0) return [...words];
  const row = symbolAt === 0 && words.length > 1 && words.slice(1).every(isFigure);
  const value = (word: string, index: number) => index !== symbolAt && (isNumberCell(word) || (row && isFigure(word)));
  beside.push(...words.filter(value));
  return words.filter((word, index) => !value(word, index));
}

/**
 * The entries of typed arguments (`splitSymbolArgs`), without the figures
 * beside their symbols (`withoutFigures`), which go to `beside`. An entry with
 * spaces (`ED 2.582,52` between semicolons) loses its figures the same way.
 */
function typedEntries(args: readonly string[], beside: string[]): string[] {
  return args.flatMap((arg) => splitSymbolArgLines(arg).flatMap((line) => withoutFigures(line, beside)
    .map((entry) => withoutFigures(entry.split(" "), beside).join(" "))
    .filter(Boolean)));
}

/** Whether standard input is a pipe or a file rather than a terminal, so a command may read its list from it. */
function stdinIsPiped(): boolean {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
    // Intentional ignore: An unavailable standard input cannot supply an optional symbol list.
    return false;
  }
}

export interface SymbolListSource {
  /** The arguments after the list name, symbols and `-` for standard input. */
  args: readonly string[];
  /** `--file <path>`. */
  file?: string;
  /** Reads standard input; injected so tests never block on it. */
  readStdin?: () => Promise<string>;
  /** Whether standard input was piped in, so a command given no symbols reads it. */
  stdinPiped?: boolean;
  /**
   * Reads the typed entries (`splitSymbolArgs`) as symbols, such as
   * `readNameEntries`, which keeps a company's name whole, and then the
   * entries of each list a file or standard input holds. Called first for
   * what was typed, even when that is nothing. Without it every entry is its
   * words, each a symbol.
   */
  readEntries?: (entries: string[]) => Promise<string[]>;
}

export class SymbolListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymbolListError";
  }
}

/**
 * The symbols a command was given: as arguments, from `--file`, and from
 * standard input when an argument is `-` or nothing else was given and input
 * is piped in. This is the one reader of `watchlist add`, `portfolio add`,
 * `quote`, `compare` and the command bar's pasted list. Repeats are dropped. A
 * separator stuck to a symbol in a file, or left on the end of what was typed
 * (`UPST;`), is dropped with the quote marks around it, and the cells beside
 * the symbols of a table read by its first column, or the figures typed beside
 * a symbol, are left out; `notes` names each so the command can say so, the
 * numbers in one line: a number (`2.582,52`, `1,899.21`, `12%`) is never a
 * symbol, beside one or on its own. An entry that names nothing (`N/A`, `$$$`,
 * `--`) stays in `symbols`, for the lookup to refuse without asking anything
 * (`notASymbolError`) and the command to name.
 */
export async function readSymbolList(source: SymbolListSource): Promise<{ symbols: string[]; repeated: number; notes: string[] }> {
  const readStdin = source.readStdin ?? (() => Bun.stdin.text());
  const wantsStdin = source.args.includes("-") || source.file === "-";
  const typedArgs = source.args.filter((arg) => arg !== "-");
  const figures: string[] = [];
  const entries = typedEntries(typedArgs, figures);
  const readEntries = (read: string[]) => source.readEntries ? source.readEntries(read) : Promise.resolve(splitSymbolWords(read));
  const typed = source.readEntries ? await source.readEntries(entries) : splitSymbolWords(entries);
  const collected = [...typed];
  // A separator left on the end of what was typed: `UPST;`, or a list that ends in a comma.
  const strays = new Set<string>(stripStrayEdges(typedArgs.join(" ")).notes);
  const ignored: string[] = [];
  const addCells = async ({ symbols, ignored: beside, entries: whole }: SymbolText) => {
    const cells = symbols.map((cell) => {
      const cleaned = stripStrayEdges(cell);
      cleaned.notes.forEach((note) => strays.add(note));
      return cleaned.text;
    }).filter(Boolean);
    // A list's lines and names are read as typed entries are: `Altria Group` stays one company.
    collected.push(...whole ? await readEntries(cells) : cells);
    ignored.push(...beside);
  };
  if (source.file != null && source.file !== "-") {
    if (!source.file.trim() || source.file.startsWith("--")) throw new SymbolListError("--file needs a path, such as --file symbols.csv.");
    let text: string;
    try {
      text = await readFile(source.file, "utf-8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new SymbolListError(code === "ENOENT" ? `No file at ${source.file}.` : `Could not read ${source.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await addCells(parseSymbolText(text));
  }
  if (wantsStdin || (typed.length === 0 && source.file == null && (source.stdinPiped ?? stdinIsPiped()))) {
    await addCells(parseSymbolText(await readStdin()));
  }
  // A number where a symbol goes (a line of prices, a typed 1.899) is left out with those typed beside a symbol.
  const numbers = [...figures, ...collected.filter(isNumberCell)];
  const notes = [ignoredCellsNote(ignored), ignoredNumbersNote(numbers)].filter((note): note is string => !!note);
  return { ...uniqueSymbols(collected.filter((symbol) => !isNumberCell(symbol))), notes: [...strays, ...notes] };
}
