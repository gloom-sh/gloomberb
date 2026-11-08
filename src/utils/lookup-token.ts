import type { HeadlessPaneDefinition } from "../types/headless";

/** A code or word as lookups compare it: `$VX`, `vix-futures` and `VIX Futures` alike. */
export function normalizeLookupToken(value: string): string {
  return value.trim().replace(/^\$/, "").toLowerCase().replace(/[\s_-]+/g, "");
}

type DiscoveryOpening = NonNullable<NonNullable<HeadlessPaneDefinition["discovery"]>["opens"]>[number];

/**
 * The case of a function a typed word names (`discovery.opens`: `VX` and
 * `vix futures` are CTM's VIX curve), or null: what `fn VX` runs and the
 * command bar's row for `vix futures` opens.
 */
export function discoveryOpening(
  discovery: HeadlessPaneDefinition["discovery"] | null | undefined,
  word: string,
): DiscoveryOpening | null {
  const wanted = normalizeLookupToken(word);
  if (!wanted) return null;
  return discovery?.opens?.find((opening) => opening.words.some((entry) => normalizeLookupToken(entry) === wanted)) ?? null;
}
