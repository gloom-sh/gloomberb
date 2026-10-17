import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import { findListingOfCompanyName, isCompanyNameInput } from "../tickers/company-name-listing";
import { isNotATickerMessage } from "./not-a-ticker";
import { splitSymbolWords } from "./symbol-args";

/**
 * The entries of a list (`splitSymbolArgs`) as the symbols a command
 * resolves. An entry with a space in it is a company's name when search finds
 * the company (`Whirlpool Corporation`), and stays whole for its listing to
 * say what it was read as; otherwise it is its words, each a symbol, as a
 * pasted line always was (`brk.b bf-b`). Only those entries cost a search.
 */
export async function readNameEntries(
  entries: readonly string[],
  dataProvider: Pick<DataProvider, "search">,
): Promise<string[]> {
  const read = await Promise.all(entries.map(async (entry) => (
    isCompanyNameInput(entry) && await findListingOfCompanyName(dataProvider, entry) ? [entry] : splitSymbolWords([entry])
  )));
  return read.flat();
}

/** What one quoted argument with spaces is (`quotedPhrase`), as `readPhraseArgument` reads it. */
export type PhraseReading =
  | { kind: "name"; name: string }
  | { kind: "symbols"; symbols: string[] }
  | { kind: "phrase"; phrase: string };

/**
 * One quoted argument with spaces: a company's name when search finds the
 * company (`"Whirlpool Corporation"`), else a pasted line of symbols when no
 * word is one the source says is not a ticker (`"AAPL MSFT"`), else a phrase
 * (`"10 year yield"`), which is never split into symbols such as YEAR and
 * YIELD. The words are asked in one batch beside the name search, not a
 * request each; a word written as a listing (`SAN:EPA`) is taken as one.
 */
export async function readPhraseArgument(
  phrase: string,
  dataProvider: Pick<DataProvider, "search" | "getQuotesBatch">,
): Promise<PhraseReading> {
  const words = splitSymbolWords([phrase]);
  const asked = words.filter((word) => !word.includes(":")).map((word) => word.replace(/^\$/, "").toUpperCase());
  const [named, results] = await Promise.all([
    findListingOfCompanyName(dataProvider, phrase),
    asked.length > 0 && dataProvider.getQuotesBatch
      ? dataProvider.getQuotesBatch(asked.map((symbol) => ({ symbol, exchange: "" }))).catch(logFailure("cli.name-entries", "Read quote names failed", []))
      : [],
  ]);
  if (named) return { kind: "name", name: phrase };
  // A word the source could not answer for (an outage) is given the benefit of the doubt, as the line was before.
  const notTicker = results.some(({ quote, error }) => !quote && isNotATickerMessage(error instanceof Error ? error.message : String(error ?? "")));
  return notTicker ? { kind: "phrase", phrase } : { kind: "symbols", symbols: words };
}
