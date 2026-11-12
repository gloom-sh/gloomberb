import type { ShortcutArgError } from "../types/plugin";
import { listingSuffixVenue } from "../sources/listing-symbols";
import { canonicalExchange, canonicalTickerKey, parsePublicTickerKey } from "../utils/exchanges";
import { listingAbroadVenue } from "../utils/sec";

/** Collections an unknown-name error lists, so the caller can retry with one. */
const LISTED_COLLECTIONS = 12;
/** Names the command bar lists under an unknown one: they share one row of the bar. */
const LISTED_COLLECTION_NAMES = 6;

/** How a collection argument is read: `prefix` also takes the start of one collection's name. */
export interface CollectionNameOptions {
  /**
   * `PF family` opens Family Office when no other collection's name starts
   * with "family". Ids are internal, so only a whole one reads. For what
   * opens a pane or a report; a command that changes or deletes a collection
   * takes its whole name.
   */
  prefix?: boolean;
}

/**
 * The portfolio or watchlist an argument names, by its id or its name,
 * trimmed and in any case: `Family`, `family` and `FAMILY` are one portfolio.
 * An exact id wins over another collection's name. Every command and function
 * that takes a portfolio or watchlist argument reads it here.
 */
export function findNamedCollection<T extends { id: string; name: string }>(
  collections: readonly T[],
  raw: string | null | undefined,
  { prefix = false }: CollectionNameOptions = {},
): T | null {
  const wanted = raw?.trim() ?? "";
  if (!wanted) return null;
  const exact = collections.find((entry) => entry.id === wanted);
  if (exact) return exact;
  const normalized = wanted.toLowerCase();
  const named = collections.find((entry) => (
    entry.id.toLowerCase() === normalized || entry.name.trim().toLowerCase() === normalized
  ));
  if (named || !prefix) return named ?? null;
  const started = collectionsStartingWith(collections, normalized);
  return started.length === 1 ? started[0]! : null;
}

/** The collections whose name starts with `wanted`, in their order. */
function collectionsStartingWith<T extends { id: string; name: string }>(collections: readonly T[], wanted: string): T[] {
  const start = wanted.trim().toLowerCase();
  if (!start) return [];
  return collections.filter((entry) => entry.name.trim().toLowerCase().startsWith(start));
}

/**
 * What a list argument that names a watchlist reads (`SIW HY3`): its symbols,
 * at most a function's `maximum`, and a note saying the name was read as the
 * watchlist, which matters when it is a ticker too (`AI`): `Read AI as
 * watchlist AI (12 symbols).` or `Read HY3 as watchlist HY3 (70 symbols); the
 * first 60 are read.` Every function's list argument, in `fn` and in the
 * command bar, reads a watchlist's name here.
 */
/**
 * What a saved ticker is read as in a function's list: its symbol, with its
 * venue for a listing abroad (ASML:AMS, 2330:TWSE), as the same symbols typed
 * read. A bare `ASML` is the US line, so a watchlist read as `ASML`, `2330`
 * compared the wrong listings and exported keys a join collided on. A symbol
 * that names its venue reads by the one code RV and `compare` print: ASML:XAMS
 * as ASML:AMS, a vendor's 2330.TW as 2330:TWSE. US listings and venues with
 * no home market (futures, currencies, coins) stay bare.
 */
export function watchlistMemberSymbol(metadata: { ticker: string; exchange?: string | null }): string {
  const { ticker } = metadata;
  if (parsePublicTickerKey(ticker).exchange) return canonicalTickerKey(ticker);
  const suffixed = listingSuffixVenue(ticker, metadata.exchange ?? undefined);
  if (suffixed) return `${suffixed.symbol}:${suffixed.exchange}`;
  const exchange = canonicalExchange(metadata.exchange ?? undefined);
  const key = exchange ? `${ticker}:${exchange}` : ticker;
  return listingAbroadVenue(key) ? key : ticker;
}

export function readWatchlistArgument(
  typed: string,
  watchlist: { name: string },
  members: readonly string[],
  maximum: number | undefined,
): { symbols: string[]; note: string } {
  const read = `Read ${typed.trim()} as watchlist ${watchlist.name} (${members.length} symbol${members.length === 1 ? "" : "s"})`;
  if (maximum == null || members.length <= maximum) return { symbols: [...members], note: `${read}.` };
  return { symbols: members.slice(0, maximum), note: `${read}; the first ${maximum} are read.` };
}

/**
 * The command bar's row for a function typed with a portfolio or watchlist
 * nothing has (`PF Nope`, `PORT Nope`), or null when one of `collections` has
 * that name or id. `noun` says what was looked for; `form` writes each name
 * the way the function takes it (`PORT:Book` for EXPO).
 */
export function unknownCollectionArgError(
  raw: string,
  collections: readonly { id: string; name: string }[],
  noun: "portfolio" | "watchlist" | "portfolio or watchlist",
  form: (name: string) => string = (name) => name,
  options: CollectionNameOptions = {},
): ShortcutArgError | null {
  const wanted = raw.trim();
  if (findNamedCollection(collections, wanted, options)) return null;
  const nameOf = (collection: { id: string; name: string }) => form(collection.name.trim() || collection.id);
  // A start several names share says which, rather than that none has it.
  const started = options.prefix ? collectionsStartingWith(collections, wanted) : [];
  if (started.length > 1) {
    const listed = started.slice(0, LISTED_COLLECTION_NAMES).map(nameOf);
    const more = started.length - listed.length;
    return {
      message: `"${wanted}" starts more than one ${noun}`,
      detail: more > 0 ? `Type more of ${listed.join(", ")} or ${more} more` : `Type more of ${listed.slice(0, -1).join(", ")} or ${listed.at(-1)}`,
    };
  }
  const names = collections.map(nameOf);
  const listed = names.slice(0, LISTED_COLLECTION_NAMES);
  const more = names.length - listed.length;
  const plural = noun === "portfolio or watchlist" ? "portfolios or watchlists" : `${noun}s`;
  return {
    message: `No ${noun} named "${wanted}"`,
    detail: listed.length === 0 ? `No ${plural} are set up`
      : more > 0 ? `Try ${listed.join(", ")} or ${more} more`
      : listed.length === 1 ? `Try ${listed[0]}`
      : `Try ${listed.slice(0, -1).join(", ")} or ${listed.at(-1)}`,
  };
}

/** "Main Portfolio (main), Family (family)": each collection's name and id, for an error naming what there is. */
export function describeCollections(collections: readonly { id: string; name: string }[]): string {
  const listed = collections.slice(0, LISTED_COLLECTIONS).map(({ id, name }) => (
    name.trim() && name.trim() !== id ? `${name.trim()} (${id})` : id
  ));
  const more = collections.length - LISTED_COLLECTIONS;
  return `${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
