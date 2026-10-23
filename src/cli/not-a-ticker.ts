import { notATickerSymbol } from "../sources/provider-errors";
import { boardCoinFor } from "./board-coins";
import { splitSymbolArgs, splitSymbolWords } from "./symbol-args";
import { treasuryYieldHint, treasuryYieldTenor } from "./treasury-yields";

// "Not a ticker: APPLE." as the router words it; the symbol ends at the sentence's own period.
// One that already names what to try (a search, a FRED series, a yield, the pair search offered) is left alone.
const NOT_A_TICKER_SENTENCE = /Not a ticker: ((?:(?!\.\s)[^\n`\x1b])+?)\.(?=\s|\x1b|$)(?! Try `gloomberb (?:search|fred|quote) | Did you mean )/g;

/**
 * The symbol as the user typed it on the command line (`Apple`), not as the router saw it (`APPLE`).
 * A symbol list splits as the commands split it; a command that takes one name (`Apple Inc`) is
 * matched as the whole argument first, so the hint searches for the name.
 */
function typedSymbol(symbol: string, args: readonly string[]): string {
  const wanted = symbol.toUpperCase();
  for (const arg of args) {
    const whole = arg.trim().replace(/^\$/, "");
    if (/\s/.test(whole) && whole.toUpperCase() === wanted) return whole;
  }
  for (const part of [...splitSymbolArgs(args), ...splitSymbolWords(args)]) {
    const typed = part.replace(/^\$/, "");
    if (typed.toUpperCase() === wanted) return typed;
  }
  return symbol;
}

/** "Try `gloomberb search Apple`." naming what the user typed; a venue (`Apple:NYSE`) is not part of a search. */
function searchHint(typed: string): string {
  const query = typed.split(":")[0]!.trim() || typed;
  return `Try \`gloomberb search ${/\s/.test(query) ? JSON.stringify(query) : query}\`.`;
}

/** Whether an id is a FRED series the catalog charts (DFEDTARU), which `gloomberb fred` prints. */
export type FredSeriesCheck = (seriesId: string) => boolean;

/**
 * Adds the search hint after each "Not a ticker: APPLE." in text meant for a person. The router
 * only knows the symbol upper-cased, so the hint reads the user's own spelling from `args`. A FRED
 * series id (DFEDTARU) is no ticker search finds, so its hint is the `fred` command instead, a
 * coin on the crypto board typed bare (USDT, TETHER) names its one symbol, USDT-USD, once
 * `primeBoardCoins` has read the board, and a Treasury yield typed as a ticker (US10Y) names the
 * commands that have it. A one-word company name a line says was read as a listing ("Read
 * "APPLE" as AAPL:NASDAQ") is put back in the user's spelling too.
 */
export function withSearchHints(text: string, args: readonly string[], isFredSeries: FredSeriesCheck = () => false): string {
  const named = withTypedNames(text, args);
  return named.includes("Not a ticker: ")
    ? named.replace(NOT_A_TICKER_SENTENCE, (sentence, symbol: string) => {
      const typed = typedSymbol(symbol, args);
      const id = typed.toUpperCase();
      if (/^[A-Z0-9]+$/.test(id) && isFredSeries(id)) return `${sentence} Try \`gloomberb fred ${id}\`.`;
      const coin = boardCoinFor(id);
      if (coin) return `${sentence} Did you mean ${coin.symbol}${coin.name && coin.name.toUpperCase() !== coin.symbol ? ` (${coin.name})` : ""}?`;
      const tenor = treasuryYieldTenor(typed);
      return `${sentence} ${tenor ? treasuryYieldHint(tenor) : searchHint(typed)}`;
    })
    : named;
}

// "Read "APPLE" as AAPL:NASDAQ (Apple Inc.)." as a list reads a one-word name, upper-cased like a symbol.
const READ_AS_NAME = /Read "([^"\n]+)" as /g;

/** A company's name the line says was read as a listing, in the user's own spelling from `args` (`Apple`). */
function withTypedNames(text: string, args: readonly string[]): string {
  return text.includes("Read \"") ? text.replace(READ_AS_NAME, (_line, name: string) => `Read "${typedSymbol(name, args)}" as `) : text;
}

/**
 * "Not a ticker: USD_NGN. Did you mean USDNGN=X (US Dollar/Nigerian Naira)?",
 * the listing search suggests, which takes the place of the search hint.
 */
export function withListingSuggestion(message: string, suggestion: string): string {
  const symbol = notATickerSymbol(message);
  if (!symbol || message.includes(" Did you mean ")) return message;
  const sentence = `Not a ticker: ${symbol}.`;
  return message.replace(sentence, `${sentence} Did you mean ${suggestion}?`);
}

/** Whether an error message says the symbol is not a ticker. */
export function isNotATickerMessage(message: string | null | undefined): boolean {
  return message != null && notATickerSymbol(message) !== null;
}
