import type { DataProvider } from "../types/data-provider";
import { findListingOfCompanyName, isCompanyNameInput } from "../tickers/company-name-listing";
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
