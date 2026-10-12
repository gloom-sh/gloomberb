/**
 * Symbols given as command arguments, each of which may hold several split by
 * commas, semicolons, spaces, tabs or newlines (a pasted list), with the blanks
 * dropped and the typed case kept. Every command that takes a symbol list splits
 * its arguments here, and `not-a-ticker` reads the typed spelling back from them.
 */
export function splitSymbolArgs(args: readonly string[]): string[] {
  return args.flatMap((arg) => arg.replace(/^\uFEFF/, "").split(/[\s,;]+/)).filter(Boolean);
}

/** How a symbol is compared for repeats: AAPL, aapl and $AAPL are one. */
export function symbolInputKey(symbol: string): string {
  return symbol.trim().replace(/^\$/, "").toUpperCase();
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
