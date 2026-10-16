/** The quote marks a pasted list wraps its entries in: "AAPL", 'MSFT', “NVDA”. */
const QUOTE_MARKS = "\"'`\u2018\u2019\u201C\u201D";
const QUOTE_EDGES = new RegExp(`^[${QUOTE_MARKS}]+|[${QUOTE_MARKS}]+$`, "g");

/** What separates the entries of a list: a comma, a semicolon, a tab (a sheet's cells) or a line. */
const LIST_SEPARATOR = /[,;\t\r\n]/;

/**
 * Symbols given as command arguments, each of which may hold several (a pasted
 * list), with the blanks dropped, the quote marks around each entry removed
 * and the typed case kept. An argument with commas, semicolons, tabs or lines
 * in it is split on those alone, so an entry can be a company's name (`WHR,
 * Whirlpool Corporation, BRK.B`); one without them is split on spaces (`JNK
 * EMB BRK.B`). Every command that takes a symbol list splits its
 * arguments here, and `not-a-ticker` reads the typed spelling back from them.
 */
export function splitSymbolArgs(args: readonly string[]): string[] {
  return args
    .flatMap((arg) => {
      const text = arg.replace(/^\uFEFF/, "");
      return LIST_SEPARATOR.test(text) ? text.split(LIST_SEPARATOR) : text.split(/\s+/);
    })
    .map((entry) => entry.trim().replace(QUOTE_EDGES, "").trim().replace(/\s+/g, " "))
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
  const entries = splitSymbolArgs([inner]);
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
