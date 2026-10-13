import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import { LISTING_SEARCH_LIMIT, searchTickerCandidates, type TickerSearchCandidate } from "../tickers/search";
import { mapWithConcurrency } from "../utils/concurrency";
import { TickerNotFoundError } from "./ticker-resolution";

/** How long a suggestion waits for search; a slow search leaves the plain "not found" as it was. */
const SUGGESTION_TIMEOUT_MS = 6_000;
/** Searches in flight at once while a list's missing symbols are looked up. */
const SUGGESTION_CONCURRENCY = 4;
/** A list with more missing symbols than this is an import with stale codes, not a typo; it gets no suggestions and no extra searches. */
export const MAX_SUGGESTED_SYMBOLS = 10;
/** Symbols shorter than this are too short for one edit to leave them recognisable. */
const MIN_TYPO_LENGTH = 4;

export interface ListingSuggestion {
  /** The listing as `search` prints it: USDNGN=X. */
  symbol: string;
  name: string;
}

interface SuggestionDeps {
  store: { loadAllTickers(): Promise<TickerRecord[]> };
  dataProvider: DataProvider;
  /** Replaces the search, for a caller that already has the candidates. */
  search?: (query: string) => Promise<TickerSearchCandidate[]>;
  timeoutMs?: number;
}

/** The text of a symbol or a name with its case, spaces, punctuation and a leading `$` gone: `USD-NGN` and `USD/NGN` are `USDNGN`. */
function compact(text: string): string {
  return text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** A symbol as people type it: without the `=X` or `=F` a pair or a future carries, and without its venue (`BTCUSDT:BYBIT`). */
function typedForm(symbol: string): string {
  return compact(symbol.split(":")[0]!.replace(/=[A-Z]?$/i, ""));
}

/** The edits (insert, delete, replace, swap two neighbours) between two strings, up to two; anything further apart is 2. */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  const rows: number[][] = Array.from({ length: left.length + 1 }, (_, row) => [row, ...new Array<number>(right.length).fill(0)]);
  for (let column = 1; column <= right.length; column += 1) rows[0]![column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const same = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(rows[row - 1]![column]! + 1, rows[row]![column - 1]! + 1, rows[row - 1]![column - 1]! + same);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, rows[row - 2]![column - 2]! + 1);
      }
      rows[row]![column] = best;
    }
  }
  return rows[left.length]![right.length]!;
}

function candidateName(candidate: TickerSearchCandidate): string {
  return candidate.detail.split(" | ")[0]?.trim() ?? "";
}

/** 0 when the candidate is the typed symbol with other punctuation (`USD-NGN` for `USDNGN=X`) or named so, 1 for one slip of the keys, null for anything else. */
function nearness(typed: string, candidate: TickerSearchCandidate): number | null {
  const wanted = compact(typed);
  if (!wanted) return null;
  const symbol = typedForm(candidate.label || candidate.symbol);
  if (wanted === symbol || wanted === compact(candidateName(candidate))) return 0;
  return wanted.length >= MIN_TYPO_LENGTH && symbol.length >= MIN_TYPO_LENGTH && editDistance(wanted, symbol) === 1 ? 1 : null;
}

/**
 * The search hit a symbol that was not found most likely meant, or null.
 * Only a real near match counts: the same letters and digits with other
 * punctuation, or one slip in a symbol of four characters or more. The first
 * result is never taken for being first, and a tie between different symbols
 * is no suggestion at all.
 */
export function nearestListing(typed: string, candidates: readonly TickerSearchCandidate[]): ListingSuggestion | null {
  const typedKey = typed.trim().replace(/^\$/, "").toUpperCase();
  const near = candidates
    .filter((candidate) => (candidate.label || candidate.symbol).toUpperCase() !== typedKey)
    .flatMap((candidate) => {
      const tier = nearness(typed, candidate);
      return tier == null ? [] : [{ candidate, tier }];
    });
  if (near.length === 0) return null;
  const best = Math.min(...near.map((entry) => entry.tier));
  const top = near.filter((entry) => entry.tier === best).map((entry) => entry.candidate);
  if (new Set(top.map((candidate) => typedForm(candidate.label || candidate.symbol))).size > 1) return null;
  const first = top[0]!;
  return { symbol: first.label || first.symbol, name: candidateName(first) };
}

/** The suggestion as a line says it: `USDNGN=X (US Dollar/Nigerian Naira)`. */
export function describeSuggestion({ symbol, name }: ListingSuggestion): string {
  return name && name.toUpperCase() !== symbol.toUpperCase() ? `${symbol} (${name})` : symbol;
}

/** The search the `search` command runs for a query: saved tickers and the data service's matches, as many as it lists. */
async function searchAsCommand(query: string, { store, dataProvider }: SuggestionDeps): Promise<TickerSearchCandidate[]> {
  const tickers = new Map((await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const));
  return searchTickerCandidates({
    query,
    tickers,
    dataProvider,
    localLimit: 6,
    totalLimit: LISTING_SEARCH_LIMIT,
    searchContext: { limit: LISTING_SEARCH_LIMIT },
  });
}

/**
 * The listing search finds for a symbol that resolved to nothing, when it is a
 * near match; null when search finds nothing near, fails or is slow. It never
 * throws and never waits longer than the timeout.
 */
export async function suggestListing(input: string, deps: SuggestionDeps): Promise<ListingSuggestion | null> {
  const query = input.trim().replace(/^\$/, "");
  if (!query) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const candidates = await Promise.race([
      Promise.resolve().then(() => (deps.search ?? ((text: string) => searchAsCommand(text, deps)))(query)),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs ?? SUGGESTION_TIMEOUT_MS); }),
    ]);
    return candidates ? nearestListing(query, candidates) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The answer for a symbol search lists nothing for, with nothing else said (a company that left its symbol, a wrong exchange, a stopped listing each say more). */
const PLAIN_NO_MATCH = /^No ticker match found for ".*"\.$/s;

/** Whether the message is the plain no-match answer, the one a suggestion can sit beside. */
export function isPlainNoMatch(message: string | null | undefined): boolean {
  return message != null && PLAIN_NO_MATCH.test(message);
}

/**
 * The error a single symbol failed with, and when it is search finding no
 * listing for the symbol, that error with the nearest listing named in its
 * message: `No ticker match found for "USD-NGN"; did you mean USDNGN=X (US
 * Dollar/Nigerian Naira)?`. Any other error comes back as it is.
 */
export async function withSuggestion(error: unknown, input: string, deps: SuggestionDeps): Promise<unknown> {
  if (!(error instanceof TickerNotFoundError) || !isPlainNoMatch(error.message)) return error;
  const suggestion = await suggestListing(input, deps);
  return suggestion ? new TickerNotFoundError(`${error.message.replace(/\.$/, "")}; did you mean ${describeSuggestion(suggestion)}?`) : error;
}

/** The suggestion of each input, null where there is none; none at all for more than `MAX_SUGGESTED_SYMBOLS`. */
export async function suggestListings(inputs: readonly string[], deps: SuggestionDeps): Promise<Array<ListingSuggestion | null>> {
  if (inputs.length > MAX_SUGGESTED_SYMBOLS) return inputs.map(() => null);
  return mapWithConcurrency(inputs, SUGGESTION_CONCURRENCY, (input) => suggestListing(input, deps));
}
