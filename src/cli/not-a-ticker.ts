import { notATickerSymbol } from "../sources/provider-errors";

// "Not a ticker: APPLE." as the router words it; the symbol ends at the sentence's own period.
const NOT_A_TICKER_SENTENCE = /Not a ticker: ((?:(?!\.\s)[^\n`\x1b])+?)\.(?=\s|\x1b|$)(?! Try `gloomberb search)/g;

/** The symbol as the user typed it on the command line (`Apple`), not as the router saw it (`APPLE`). */
function typedSymbol(symbol: string, args: readonly string[]): string {
  const wanted = symbol.toUpperCase();
  for (const arg of args) {
    for (const part of arg.split(",")) {
      const typed = part.trim().replace(/^\$/, "");
      if (typed.toUpperCase() === wanted) return typed;
    }
  }
  return symbol;
}

/** "Try `gloomberb search Apple`." naming what the user typed; a venue (`Apple:NYSE`) is not part of a search. */
function searchHint(typed: string): string {
  const query = typed.split(":")[0]!.trim() || typed;
  return `Try \`gloomberb search ${/\s/.test(query) ? JSON.stringify(query) : query}\`.`;
}

/**
 * Adds the search hint after each "Not a ticker: APPLE." in text meant for a person. The router
 * only knows the symbol upper-cased, so the hint reads the user's own spelling from `args`.
 */
export function withSearchHints(text: string, args: readonly string[]): string {
  return text.includes("Not a ticker: ")
    ? text.replace(NOT_A_TICKER_SENTENCE, (sentence, symbol: string) => `${sentence} ${searchHint(typedSymbol(symbol, args))}`)
    : text;
}

/** Whether an error message says the symbol is not a ticker. */
export function isNotATickerMessage(message: string | null | undefined): boolean {
  return message != null && notATickerSymbol(message) !== null;
}
