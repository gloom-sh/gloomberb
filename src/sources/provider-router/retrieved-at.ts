import type { Quote } from "../../types/financials";

/**
 * The quote with when Gloom fetched it from its source (`retrievedAt`): `at`,
 * the moment a source answered or the time a saved copy was fetched. A quote
 * that already says keeps its own time, so a copy read back from the cache is
 * never dated by the read.
 */
export function withRetrievedAt<T extends Quote | null | undefined>(quote: T, at: number | undefined): T {
  if (!quote || !Number.isFinite(at) || Number.isFinite(quote.retrievedAt)) return quote;
  return { ...quote, retrievedAt: at };
}
