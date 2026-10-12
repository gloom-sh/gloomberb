/** Collections an unknown-name error lists, so the caller can retry with one. */
const LISTED_COLLECTIONS = 12;

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

/** "Main Portfolio (main), Family (family)": each collection's name and id, for an error naming what there is. */
export function describeCollections(collections: readonly { id: string; name: string }[]): string {
  const listed = collections.slice(0, LISTED_COLLECTIONS).map(({ id, name }) => (
    name.trim() && name.trim() !== id ? `${name.trim()} (${id})` : id
  ));
  const more = collections.length - LISTED_COLLECTIONS;
  return `${listed.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}
