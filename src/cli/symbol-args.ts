/**
 * Symbols given as command arguments, each of which may hold several split by
 * commas, semicolons, spaces, tabs or newlines (a pasted list), with the blanks
 * dropped and the typed case kept. Every command that takes a symbol list splits
 * its arguments here, and `not-a-ticker` reads the typed spelling back from them.
 */
export function splitSymbolArgs(args: readonly string[]): string[] {
  return args.flatMap((arg) => arg.replace(/^\uFEFF/, "").split(/[\s,;]+/)).filter(Boolean);
}
