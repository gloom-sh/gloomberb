import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import { findListingOfCompanyName, isCompanyNameInput, readTerminalCodeArg } from "../tickers/company-name-listing";
import { isNotATickerMessage } from "./not-a-ticker";
import { splitSymbolWords } from "./symbol-args";
import { isNumberCell } from "./symbol-cells";
import { isProviderBusy } from "../sources/provider-errors";
import { unknownBloombergMarket } from "../tickers/terminal-codes";

/**
 * The entries of a list (`splitSymbolArgs`, or a file's lines) as the symbols
 * a command resolves. An entry with a space in it is a company's name when
 * search finds the company (`Whirlpool Corporation`, `philip morris intl`),
 * and stays whole for its listing to say what it was read as. One search
 * finds no company for is its words, each a symbol, when each is written as
 * a symbol or has a quote (`AAPL MSFT`, `brk.b bf-b`, `aapl msft` on a
 * pasted line), and otherwise stays whole, a name nothing lists: its words
 * are not taken for other companies' symbols (INTL, a fund, from a misspelt
 * `phillip morris intl`). Only those entries cost a search. One search was
 * too busy to look up also stays whole, so its lookup says so instead of
 * resolving its words as symbols of other companies.
 */
export async function readNameEntries(
  entries: readonly string[],
  dataProvider: Pick<DataProvider, "search"> & Partial<Pick<DataProvider, "getQuotesBatch" | "getQuote">>,
): Promise<string[]> {
  const read = await Promise.all(entries.map(async (entry) => {
    // A terminal's code for a listing ("JPM US Equity", "VOD LN") is one entry, like a company's name, and so is a
    // line written as one whose market code is unknown ("AAPL GP"): its lookup refuses it, never AAPL and GP.
    if (unknownBloombergMarket(entry) || await readTerminalCodeArg(dataProvider, entry)) return [entry];
    if (!isCompanyNameInput(entry)) return splitSymbolWords([entry]);
    if (await findListingOfCompanyName(dataProvider, entry).catch(busyAsFound)) return [entry];
    const words = splitSymbolWords([entry]);
    return await wordsAreSymbols(words, dataProvider) ? words : [entry];
  }));
  return read.flat();
}

/** A word typed as a ticker is: in capitals (AAPL, 7203.T), with a venue or class mark (brk.b, bf-b, SAN:EPA), or after a $. */
function writtenAsSymbol(word: string): boolean {
  return /^\$|[:.\-/=^]/.test(word) || /\d/.test(word) || (/\p{Lu}/u.test(word) && !/\p{Ll}/u.test(word));
}

/**
 * Whether the words of an entry search found no company for are symbols:
 * each written as one (2222, BRK.B) or else with a quote, the others asked in
 * one batch (`2222 amd pltr`). A batch that fails says nothing, and the
 * entry stays a name.
 */
async function wordsAreSymbols(
  words: readonly string[],
  dataProvider: Partial<Pick<DataProvider, "getQuotesBatch" | "getQuote">>,
): Promise<boolean> {
  const symbols = words.filter((word) => !writtenAsSymbol(word)).map((word) => word.replace(/^\$/, "").toUpperCase());
  if (symbols.length === 0) return true;
  if (dataProvider.getQuotesBatch) {
    const results = await dataProvider.getQuotesBatch(symbols.map((symbol) => ({ symbol, exchange: "" })))
      .catch(logFailure("cli.name-entries", "Read quotes for a pasted line failed", []));
    return results.length === symbols.length && results.every(({ quote }) => !!quote);
  }
  // A source without batches is asked a quote at a time: the few words not written as symbols.
  const { getQuote } = dataProvider;
  if (!getQuote) return false;
  const quoted = await Promise.all(symbols.map((symbol) => getQuote(symbol, "").then(
    (quote) => !!quote,
    logFailure("cli.name-entries", "Read a quote for a pasted line failed", false),
  )));
  return quoted.every(Boolean);
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
 * request each; a word written as a listing (`SAN:EPA`) is taken as one, and
 * a number (`10.5`, `5.25%`) is never asked: it makes the line a phrase.
 * When search is too busy to say whether it names a company, a line whose
 * every word has a quote is still symbols; anything else throws
 * `ProviderBusyError`, as its words may be other companies' symbols.
 */
export async function readPhraseArgument(
  phrase: string,
  dataProvider: Pick<DataProvider, "search" | "getQuotesBatch">,
): Promise<PhraseReading> {
  if (unknownBloombergMarket(phrase) || await readTerminalCodeArg(dataProvider, phrase)) return { kind: "symbols", symbols: [phrase] };
  const words = splitSymbolWords([phrase]);
  const numbered = words.some(isNumberCell);
  const asked = words.filter((word) => !word.includes(":") && !isNumberCell(word)).map((word) => word.replace(/^\$/, "").toUpperCase());
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
    if (!numbered && results.length === asked.length && results.every(({ quote }) => !!quote)) return { kind: "symbols", symbols: words };
    throw named;
  }
  if (named) return { kind: "name", name: phrase };
  // A word the source could not answer for (an outage) is given the benefit of the doubt, as the line was before.
  const notTicker = numbered || results.some(({ quote, error }) => !quote && isNotATickerMessage(error instanceof Error ? error.message : String(error ?? "")));
  return notTicker ? { kind: "phrase", phrase } : { kind: "symbols", symbols: words };
}
