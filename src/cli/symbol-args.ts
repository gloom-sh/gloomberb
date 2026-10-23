import { isFigure, isNumberCell, protectFigureCommas, restoreFigureCommas } from "./symbol-cells";

/** The quote marks a pasted list wraps its entries in: "AAPL", 'MSFT', “NVDA”. */
const QUOTE_MARKS = "\"'`\u2018\u2019\u201C\u201D";
const QUOTE_EDGES = new RegExp(`^[${QUOTE_MARKS}]+|[${QUOTE_MARKS}]+$`, "g");

/** What separates the entries of a list: a comma, a semicolon, a tab (a sheet's cells) or a line. */
const LIST_SEPARATOR = /[,;\t\r\n]/;

/**
 * The entries of command arguments, each of which may hold several (a pasted
 * list), with the blanks dropped, the quote marks around each entry removed
 * and the typed case kept. An argument with commas, semicolons, tabs or lines
 * in it is split on those, so an entry may be a company's name (`WHR,
 * Whirlpool Corporation, BRK.B`) or several symbols with spaces between them
 * (`brk.b bf-b` on a pasted line); one without them is split on spaces (`JNK
 * EMB BRK.B`). Which an entry with a space is takes a search: a command that
 * resolves its symbols reads them with `readNameEntries`, and a parser that
 * looks nothing up takes `splitSymbolWords`. A comma inside a figure
 * (`2.582,52`, `1,899.21`) is no separator: the figure stays one entry. One
 * between plain digits is a decimal comma only on a line with another
 * separator (`ED 2,5`); alone it splits codes (`9988,5`, `700,388`).
 */
export function splitSymbolArgs(args: readonly string[]): string[] {
  return args.flatMap((arg) => splitSymbolArgLines(arg).flat());
}

/**
 * `splitSymbolArgs` of one argument, its entries kept by the line they are
 * on, so a figure can be told to sit beside the symbol on its line.
 */
export function splitSymbolArgLines(arg: string): string[][] {
  const lines = arg.replace(/^\uFEFF/, "").split(/\r\n?|\n/).map((line) => protectFigureCommas(line));
  const separated = lines.length > 1 || lines.some((line) => LIST_SEPARATOR.test(line));
  return lines.map((line) => (separated ? line.split(/[,;\t]/) : line.split(/\s+/))
    .map((entry) => restoreFigureCommas(entry).trim().replace(QUOTE_EDGES, "").trim().replace(/\s+/g, " "))
    .filter(Boolean));
}

/**
 * The one argument a command was given, when the user quoted words with
 * spaces and no list separator into it: `quote "10 year yield"`, `quote
 * "Apple Inc"` or a pasted line `quote "AAPL MSFT"`. Which of those it is
 * takes a lookup (`readPhraseArgument`); `splitSymbolArgs` would split it
 * into words, each a symbol (10, YEAR, YIELD). A figure in it is part of
 * the phrase (`"10.5 year yield"`, `"fed funds rate 5.25%"`). Null for
 * anything else: several arguments, one word, a list with commas, or a
 * pasted row of symbols each followed by its prices (`ED 2.582,52`, `AAPL
 * 150.00 MSFT 300.00`), which is read as a list is.
 */
export function quotedPhrase(args: readonly string[]): string | null {
  if (args.length !== 1) return null;
  const text = args[0]!.replace(/^\uFEFF/, "");
  if (LIST_SEPARATOR.test(protectFigureCommas(text))) return null;
  const phrase = text.trim().replace(QUOTE_EDGES, "").trim().replace(/\s+/g, " ");
  return phrase.includes(" ") && !isPricedRow(phrase.split(" ")) ? phrase : null;
}

/**
 * Words that are a sheet's row rather than a phrase: a number (`2.582,52`)
 * among them, and each word that is no figure followed by one (`ED
 * 2.582,52`), so no two words of a name or a phrase sit side by side.
 */
function isPricedRow(words: readonly string[]): boolean {
  if (!words.some(isNumberCell) || isFigure(words[0]!)) return false;
  return words.every((word, index) => isFigure(word) || (index + 1 < words.length && isFigure(words[index + 1]!)));
}

/**
 * Symbols given as command arguments, split on commas, semicolons, spaces,
 * tabs and lines in any mix, each without its quote marks and in its typed
 * case: `"GME", 'AMC'\nBF.B brk.b` is GME, AMC, BF.B and brk.b. The split of
 * a parser that looks nothing up, and of an entry search finds no company for.
 */
export function splitSymbolWords(args: readonly string[]): string[] {
  return splitSymbolArgs(args)
    .flatMap((entry) => entry.split(" "))
    .map((word) => word.replace(QUOTE_EDGES, ""))
    .filter(Boolean);
}

/** The list separators in `text`, each once: `,;` for a stray `;,;`. */
function separatorsIn(text: string): string {
  return [...new Set([...text].filter((char) => char === "," || char === ";"))].join("");
}

/**
 * A pasted list, or one cell of a file, without the separators and quote marks
 * stuck to its ends (`UPST;`, `"GME",`). The separators it dropped are named
 * (`Ignored the stray ";" after UPST.`) rather than swallowed, and never reach
 * a listing search as part of a symbol, which would ask for `UPST;`.
 */
export function stripStrayEdges(text: string): { text: string; notes: string[] } {
  const junk = `[\\s,;${QUOTE_MARKS}]`;
  const leading = text.match(new RegExp(`^${junk}+`))?.[0] ?? "";
  const rest = text.slice(leading.length);
  const trailing = rest.match(new RegExp(`${junk}+$`))?.[0] ?? "";
  const inner = rest.slice(0, rest.length - trailing.length);
  const entries = splitSymbolWords([inner]);
  const [first, last] = [entries[0], entries.at(-1)];
  const before = separatorsIn(leading);
  const after = separatorsIn(trailing);
  const notes = !first
    ? (before || after ? [`Ignored the stray "${separatorsIn(leading + trailing)}".`] : [])
    : [
      ...before ? [`Ignored the stray "${before}" before ${first}.`] : [],
      ...after ? [`Ignored the stray "${after}" after ${last}.`] : [],
    ];
  return { text: inner, notes };
}

/** How a symbol is compared for repeats: AAPL, aapl and $AAPL are one. */
export function symbolInputKey(symbol: string): string {
  return symbol.trim().replace(/^\$/, "").toUpperCase();
}

/**
 * How a command's symbol list spots one security typed twice: `symbolInputKey`,
 * with a share class written with a dot or a dash as one (BRK.B and BRK-B).
 */
function securityInputKey(symbol: string): string {
  return symbolInputKey(symbol).replace(/-/g, ".");
}

/** The securities of a symbol list, each once, in the first spelling typed: `AAPL aapl BRK.B BRK-B` is AAPL and BRK.B. */
export function uniqueSecuritySymbols(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = securityInputKey(symbol);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The symbols without repeats, first spelling kept, and how many repeats were dropped. */
export function uniqueSymbols(symbols: readonly string[]): { symbols: string[]; repeated: number } {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const symbol of symbols) {
    const key = symbolInputKey(symbol);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(symbol.trim());
  }
  return { symbols: unique, repeated: symbols.filter((symbol) => symbolInputKey(symbol)).length - unique.length };
}
