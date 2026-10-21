import { readFile } from "fs/promises";
import { fstatSync } from "fs";
import { splitSymbolArgs, splitSymbolWords, stripStrayEdges, uniqueSymbols } from "./symbol-args";

/** Header cells that name a spreadsheet's symbol column, compared without case, spaces or punctuation. */
const SYMBOL_HEADERS = new Set(["symbol", "symbols", "ticker", "tickers", "code", "stockcode", "securitycode", "instrument"]);
/** A header naming a column of company names, read when no column names the symbols. */
const NAME_HEADERS = new Set(["name", "names", "company", "companies", "companyname", "security", "securityname", "issuer", "issuername"]);

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
 * The symbols in a file or piped text, in order. A spreadsheet export reads
 * from the column its header names (Symbol, Ticker, Code), else from its
 * Name or Company column, as `entries`. Without a header,
 * every cell is a symbol unless some column after the first holds a name, a
 * price or a weight: that table is read by its first column, and the cells
 * beside it are returned as `ignored` so the command can name them. A list
 * split by commas, spaces or newlines gives every entry, even when a line of
 * it is ragged or carries a stray separator (`"BIMAS ,"`). A list of lines
 * gives each line whole, and a list of names split by semicolons or commas
 * (one line, or one name a line) each cell, as `entries`: a line with spaces
 * is a company's name (`Altria Group`) or symbols on one line, which reading
 * the entries tells apart. Names beside other text (`Apple Inc,Technology`)
 * are a table read by its first column, its names as `entries`. A list split
 * by spaces with figures beside the symbols (`AAPL 150.00`) is a table. A
 * byte order mark, Windows line ends, blank lines and lines starting with #
 * or // are ignored.
 */
export function parseSymbolText(text: string): SymbolText {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const delimiter = detectDelimiter(lines);
  const records = (delimiter ? parseDelimited(normalized, delimiter) : lines.map((line) => line.trim().split(/\s+/)))
    .filter((cells) => cells.some(Boolean) && !isComment(cells[0] ?? ""));
  if (records.length === 0) return { symbols: [], ignored: [] };
  const header = records[0]!.map(headerKey);
  const exact = header.findIndex((cell) => SYMBOL_HEADERS.has(cell));
  const column = exact >= 0 ? exact : header.findIndex((cell) => cell.includes("symbol") || cell.includes("ticker"));
  if (column >= 0) return { symbols: records.slice(1).map((cells) => cells[column] ?? "").filter(Boolean), ignored: [] };
  // Without one, a delimited export's Name or Company column holds the companies, read as typed names are.
  const nameColumn = delimiter ? header.findIndex((cell) => NAME_HEADERS.has(cell)) : -1;
  if (nameColumn >= 0) return { symbols: records.slice(1).map((cells) => cells[nameColumn] ?? "").filter(Boolean), ignored: [], entries: true };
  // A separator or quote mark stuck to a cell is dropped (and named) when it is read, so it does not make the list a table.
  const cleaned = records.map((cells) => cells.map((cell) => stripStrayEdges(cell).text));
  const figures = cleaned.some((cells) => cells.some((cell, index) => index > 0 && NUMBER_CELL.test(cell) && /\d/.test(cell)));
  // Lines split by spaces alone are entries, unless figures sit beside the symbols.
  if (!delimiter && !figures) return { symbols: records.map((cells) => cells.join(" ")), ignored: [], entries: true };
  const grid = cleaned.every((cells) => cells.every((cell, index) => !cell || (looksLikeSymbol(cell) && (index === 0 || !NUMBER_CELL.test(cell)))));
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

/**
 * The note a table read by its first column gets, naming what was left out:
 * `Read the first column as symbols; ignored the 4 cells beside it: Apple
 * Inc., 336.64, Microsoft, 535.07.` Long tables name the first few and count
 * the rest. Null when nothing was ignored.
 */
function ignoredCellsNote(ignored: readonly string[]): string | null {
  if (ignored.length === 0) return null;
  const named = ignored.slice(0, IGNORED_PREVIEW).join(", ");
  const more = ignored.length - IGNORED_PREVIEW;
  const cells = ignored.length === 1 ? "the cell" : `the ${ignored.length} cells`;
  return `Read the first column as symbols; ignored ${cells} beside it: ${named}${more > 0 ? ` and ${more} more` : ""}.`;
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
 * is piped in. Repeats are dropped. A separator stuck to a symbol in a file, or
 * left on the end of what was typed (`UPST;`), is dropped with the quote marks
 * around it, and the cells beside the symbols of a table read by its first
 * column are left out; `notes` names each so the command can say so.
 */
export async function readSymbolList(source: SymbolListSource): Promise<{ symbols: string[]; repeated: number; notes: string[] }> {
  const readStdin = source.readStdin ?? (() => Bun.stdin.text());
  const wantsStdin = source.args.includes("-") || source.file === "-";
  const typedArgs = source.args.filter((arg) => arg !== "-");
  const readEntries = (entries: string[]) => source.readEntries ? source.readEntries(entries) : Promise.resolve(splitSymbolWords(entries));
  const typed = source.readEntries ? await source.readEntries(splitSymbolArgs(typedArgs)) : splitSymbolWords(typedArgs);
  const collected = [...typed];
  // A separator left on the end of what was typed: `UPST;`, or a list that ends in a comma.
  const strays = new Set<string>(stripStrayEdges(typedArgs.join(" ")).notes);
  const ignored: string[] = [];
  const addCells = async ({ symbols, ignored: beside, entries }: SymbolText) => {
    const cells = symbols.map((cell) => {
      const cleaned = stripStrayEdges(cell);
      cleaned.notes.forEach((note) => strays.add(note));
      return cleaned.text;
    }).filter(Boolean);
    // A list's lines and names are read as typed entries are: `Altria Group` stays one company.
    collected.push(...entries ? await readEntries(cells) : cells);
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
  const ignoredNote = ignoredCellsNote(ignored);
  return { ...uniqueSymbols(collected), notes: [...strays, ...ignoredNote ? [ignoredNote] : []] };
}
