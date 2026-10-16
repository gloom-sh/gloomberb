import { readFile } from "fs/promises";
import { fstatSync } from "fs";
import { splitSymbolArgs, splitSymbolWords, stripStrayEdges, uniqueSymbols } from "./symbol-args";

/** Header cells that name a spreadsheet's symbol column, compared without case, spaces or punctuation. */
const SYMBOL_HEADERS = new Set(["symbol", "symbols", "ticker", "tickers", "code", "stockcode", "securitycode", "instrument"]);

/** One symbol as it can be typed: AAPL, $nvda, TTF.AS, SAN:EPA, BRK-B, 7203.T, ^GSPC, ES=F. */
const SYMBOL_TOKEN = /^\$?[\p{L}\p{N}^][\p{L}\p{N}.:\-^=/&]{0,23}$/u;
/** A plain number: a price, a weight or a share count in a spreadsheet's other columns. */
const NUMBER_CELL = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?%?$/;

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function isComment(cell: string): boolean {
  return cell.startsWith("#") || cell.startsWith("//");
}

/** The delimiter of the first data line: tab, comma or semicolon, or null for a list split by spaces. */
function detectDelimiter(lines: readonly string[]): string | null {
  const first = lines.find((line) => line.trim() && !isComment(line.trim()));
  if (!first) return null;
  const unquoted = first.replace(/"[^"]*"/g, "");
  for (const delimiter of ["\t", ",", ";"]) {
    if (unquoted.includes(delimiter)) return delimiter;
  }
  return null;
}

/** RFC 4180 records: a quoted cell may hold the delimiter, a newline and doubled quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
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
    if (char === "\"" && !cell.trim()) {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      record.push(cell);
      cell = "";
    } else if (char === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  return records.map((cells) => cells.map((value) => value.trim()));
}

function looksLikeSymbol(cell: string): boolean {
  return SYMBOL_TOKEN.test(cell) && !(NUMBER_CELL.test(cell) && /[.,%]/.test(cell));
}

/**
 * The symbols in a file or piped text, in order. A spreadsheet export reads
 * from the column its header names (Symbol, Ticker, Code), or else its first
 * column; a list split by commas, spaces or newlines gives every entry. A byte
 * order mark, Windows line ends, blank lines and lines starting with # or //
 * are ignored.
 */
export function parseSymbolText(text: string): string[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const delimiter = detectDelimiter(lines);
  const records = (delimiter ? parseDelimited(normalized, delimiter) : lines.map((line) => line.trim().split(/\s+/)))
    .filter((cells) => cells.some(Boolean) && !isComment(cells[0] ?? ""));
  if (records.length === 0) return [];
  const header = records[0]!.map(headerKey);
  const exact = header.findIndex((cell) => SYMBOL_HEADERS.has(cell));
  const column = exact >= 0 ? exact : header.findIndex((cell) => cell.includes("symbol") || cell.includes("ticker"));
  if (column >= 0) return records.slice(1).map((cells) => cells[column] ?? "").filter(Boolean);
  // Without a header, symbols laid out across columns are all symbols; a
  // table with names, prices or weights beside them is read by its first column.
  const grid = records.every((cells) => cells.every((cell, index) => !cell || (looksLikeSymbol(cell) && (index === 0 || !NUMBER_CELL.test(cell)))));
  return grid ? records.flat().filter(Boolean) : records.map((cells) => cells[0] ?? "").filter(Boolean);
}

/** Whether standard input is a pipe or a file rather than a terminal, so a command may read its list from it. */
function stdinIsPiped(): boolean {
  try {
    const stats = fstatSync(0);
    return stats.isFIFO() || stats.isFile();
  } catch {
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
   * `readNameEntries`, which keeps a company's name whole. Without it every
   * entry is its words, each a symbol.
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
 * is piped in. Repeats are dropped. A separator stuck to a symbol in a file, or
 * left on the end of what was typed (`UPST;`), is dropped with the quote marks
 * around it, and each is named in `strays` so the command can say so.
 */
export async function readSymbolList(source: SymbolListSource): Promise<{ symbols: string[]; repeated: number; strays: string[] }> {
  const readStdin = source.readStdin ?? (() => Bun.stdin.text());
  const wantsStdin = source.args.includes("-") || source.file === "-";
  const typedArgs = source.args.filter((arg) => arg !== "-");
  const typed = source.readEntries ? await source.readEntries(splitSymbolArgs(typedArgs)) : splitSymbolWords(typedArgs);
  const collected = [...typed];
  // A separator left on the end of what was typed: `UPST;`, or a list that ends in a comma.
  const strays = new Set<string>(stripStrayEdges(typedArgs.join(" ")).notes);
  const addCells = (cells: readonly string[]) => {
    for (const cell of cells) {
      const cleaned = stripStrayEdges(cell);
      cleaned.notes.forEach((note) => strays.add(note));
      collected.push(cleaned.text);
    }
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
    addCells(parseSymbolText(text));
  }
  if (wantsStdin || (typed.length === 0 && source.file == null && (source.stdinPiped ?? stdinIsPiped()))) {
    addCells(parseSymbolText(await readStdin()));
  }
  return { ...uniqueSymbols(collected), strays: [...strays] };
}
