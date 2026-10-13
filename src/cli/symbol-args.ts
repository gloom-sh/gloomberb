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
