import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import { findListingOfCompanyName, isCompanyNameInput, readTerminalCodeArg } from "../tickers/company-name-listing";
import { isNotATickerMessage } from "./not-a-ticker";
import { splitSymbolWords } from "./symbol-args";
import { isProviderBusy } from "../sources/provider-errors";

/**
 * The entries of a list (`splitSymbolArgs`) as the symbols a command
 * resolves. An entry with a space in it is a company's name when search finds
 * the company (`Whirlpool Corporation`), and stays whole for its listing to
 * say what it was read as; otherwise it is its words, each a symbol, as a
 * pasted line always was (`brk.b bf-b`). Only those entries cost a search.
 * One search was too busy to look up also stays whole, so its lookup says so
 * instead of resolving its words as symbols of other companies.
 */
export async function readNameEntries(
  entries: readonly string[],
  dataProvider: Pick<DataProvider, "search">,
): Promise<string[]> {
  const read = await Promise.all(entries.map(async (entry) => (
    // A terminal's code for a listing ("JPM US Equity") is one entry, like a company's name.
    await readTerminalCodeArg(dataProvider, entry) || (isCompanyNameInput(entry) && await findListingOfCompanyName(dataProvider, entry).catch(busyAsFound))
      ? [entry] : splitSymbolWords([entry])
  )));
  return read.flat();
}

/** `findListingOfCompanyName`'s busy answer as a name to keep whole, any other failure as it is. */
function busyAsFound(error: unknown): true {
  if (isProviderBusy(error)) return true;
  throw error;
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
 * When search is too busy to say whether it names a company, a line whose
 * every word has a quote is still symbols; anything else throws
 * `ProviderBusyError`, as its words may be other companies' symbols.
 */
export async function readPhraseArgument(
  phrase: string,
  dataProvider: Pick<DataProvider, "search" | "getQuotesBatch">,
): Promise<PhraseReading> {
  if (await readTerminalCodeArg(dataProvider, phrase)) return { kind: "symbols", symbols: [phrase] };
  const words = splitSymbolWords([phrase]);
  const asked = words.filter((word) => !word.includes(":")).map((word) => word.replace(/^\$/, "").toUpperCase());
  const [named, results] = await Promise.all([
    findListingOfCompanyName(dataProvider, phrase).catch((error: unknown) => {
      if (isProviderBusy(error)) return error;
      throw error;
    }),
    asked.length > 0 && dataProvider.getQuotesBatch
      ? dataProvider.getQuotesBatch(asked.map((symbol) => ({ symbol, exchange: "" }))).catch(logFailure("cli.name-entries", "Read quote names failed", []))
      : [],
  ]);
  if (isProviderBusy(named)) {
    if (results.length === asked.length && results.every(({ quote }) => !!quote)) return { kind: "symbols", symbols: words };
    throw named;
  }
  if (named) return { kind: "name", name: phrase };
  // A word the source could not answer for (an outage) is given the benefit of the doubt, as the line was before.
  const notTicker = results.some(({ quote, error }) => !quote && isNotATickerMessage(error instanceof Error ? error.message : String(error ?? "")));
  return notTicker ? { kind: "phrase", phrase } : { kind: "symbols", symbols: words };
}
