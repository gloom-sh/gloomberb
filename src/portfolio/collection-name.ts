import type { ShortcutArgError } from "../types/plugin";

/** Collections an unknown-name error lists, so the caller can retry with one. */
const LISTED_COLLECTIONS = 12;
/** Names the command bar lists under an unknown one: they share one row of the bar. */
const LISTED_COLLECTION_NAMES = 6;

/**
 * The portfolio or watchlist an argument names, by its id or its name,
 * trimmed and in any case: `Family`, `family` and `FAMILY` are one portfolio.
 * An exact id wins over another collection's name. Every command and function
 * that takes a portfolio or watchlist argument reads it here.
 */
export function findNamedCollection<T extends { id: string; name: string }>(
  collections: readonly T[],
  raw: string | null | undefined,
): T | null {
  const wanted = raw?.trim() ?? "";
  if (!wanted) return null;
  const exact = collections.find((entry) => entry.id === wanted);
  if (exact) return exact;
  const normalized = wanted.toLowerCase();
  return collections.find((entry) => (
    entry.id.toLowerCase() === normalized || entry.name.trim().toLowerCase() === normalized
  )) ?? null;
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
): ShortcutArgError | null {
  const wanted = raw.trim();
  if (findNamedCollection(collections, wanted)) return null;
  const names = collections.map((collection) => form(collection.name.trim() || collection.id));
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
