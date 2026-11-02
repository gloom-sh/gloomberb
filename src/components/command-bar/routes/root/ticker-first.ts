import { readTerminalListingCode } from "../../../../tickers/terminal-codes";

/** A plain ticker, as one word: NFE, BRK.B, 0700, VOD:LSE. */
const TICKER_WORD = /^\$?[A-Za-z0-9][A-Za-z0-9.\-]{0,11}(?::[A-Za-z0-9]{1,8})?$/;

/**
 * The ticker a query names before a function code: one word, or a terminal
 * code (`NFE US Equity`, `VOD LN`) read as its listing. Null for anything
 * else, so a company's name stays a search.
 */
function tickerBeforeCode(text: string): string | null {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return TICKER_WORD.test(words[0]!) ? words[0]!.replace(/^\$/, "").toUpperCase() : null;
  return readTerminalListingCode(text)?.key ?? null;
}

/**
 * A query in Bloomberg's word order, the ticker first, as the bar reads it:
 * `NFE CDS` and `NFE US Equity CDS` are `CDS NFE`, when `takesTicker` says
 * the last word is a function code that takes one. Null for anything else,
 * and for a whole query that is a listing's code, whose market code is a
 * function's too: `SAP GR` is SAP on Xetra, `AMD GF` AMD in Frankfurt,
 * `600519 CG` Moutai in Shanghai.
 */
export function tickerFirstQuery(query: string, takesTicker: (code: string) => boolean): string | null {
  const words = query.trim().split(/\s+/);
  if (words.length < 2 || readTerminalListingCode(query) != null) return null;
  const code = words.at(-1)!.toUpperCase();
  if (!takesTicker(code)) return null;
  const ticker = tickerBeforeCode(words.slice(0, -1).join(" "));
  return ticker ? `${code} ${ticker}` : null;
}
