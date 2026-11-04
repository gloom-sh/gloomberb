import type { CliListing } from "./listing-arg";
import { companyNameSuggestion, isUnsettledNoProvider, type ListingDeps } from "./listing-arg";
import { describeSuggestion } from "./listing-suggestion";
import { isNotATickerMessage, withListingSuggestion } from "./not-a-ticker";
import { tradingListing } from "../tickers/listing-fate";
import { parsePublicTickerKey } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";

type SearchDeps = Pick<ListingDeps, "dataProvider">;

/**
 * "Not a ticker: PALANTIR TECHNOLOGIES. Did you mean PLTR (Palantir
 * Technologies Inc.)?" for words typed where one ticker goes, with the
 * company search names for them. Without one the sentence ends at the
 * symbol, and the error printer adds the search to try.
 */
export async function notATickerWords(typed: string, deps: SearchDeps): Promise<string> {
  const symbol = typed.trim().replace(/^\$/, "").toUpperCase();
  const message = `Not a ticker: ${symbol}.`;
  const suggestion = await companyNameSuggestion(typed, deps);
  return suggestion ? withListingSuggestion(message, describeSuggestion(suggestion)) : message;
}

/**
 * Why a command stops on a listing whose own quote failed with `error`, when
 * the word typed for it is no ticker, or null when it is not known to be: the
 * source's "Not a ticker: PALANTIR.", and a word a source could not answer for
 * (a timeout, a rate limit) that search resolves to a company all the same, as
 * `quote` says it of a name. Both name the company beside it. A real ticker a
 * source failed to quote is not stopped here: it is not a company's name.
 */
export async function notATickerStop(
  error: unknown,
  listing: Pick<CliListing, "symbol" | "exchange" | "typed">,
  deps: SearchDeps,
): Promise<string | null> {
  const message = error instanceof Error ? error.message : null;
  const notATicker = isNotATickerMessage(message);
  if (!notATicker && !isUnsettledNoProvider(error)) return null;
  if (listing.exchange || !listing.typed) return notATicker ? message : null;
  const suggestion = await companyNameSuggestion(listing.typed, deps);
  if (!suggestion) return notATicker ? message : null;
  return withListingSuggestion(notATicker ? message! : `Not a ticker: ${listing.symbol}.`, describeSuggestion(suggestion));
}

/**
 * "Did you mean D05:SGX (DBS Group Holdings Ltd.)?", for a bare symbol whose
 * listing stopped trading (DBS, the Invesco silver fund delisted in 2023)
 * when search names a company by the symbol that still trades. Null when
 * search names none, names the symbol itself, or the company's line has
 * stopped too. Never throws.
 */
export async function liveCompanyQuestion(typed: string, deps: SearchDeps, now = Date.now()): Promise<string | null> {
  const suggestion = await companyNameSuggestion(typed, deps);
  if (!suggestion) return null;
  const { symbol, exchange } = parsePublicTickerKey(suggestion.symbol);
  const quote = await deps.dataProvider.getQuote(symbol, exchange ?? "")
    .catch(logFailure("cli.company-name-hint", "Quote a company suggested for a stopped symbol failed", null));
  return quote && tradingListing(quote, now) ? `Did you mean ${describeSuggestion(suggestion)}?` : null;
}
