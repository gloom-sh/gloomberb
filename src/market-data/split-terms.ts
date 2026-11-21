import type { SplitAction } from "../types/financials";

/** A factor with more shares than this on a side, and no single share on the other, is no share count a split states: GE's 1253:1000 spinoff adjustment. */
const MAX_SPLIT_SHARES = 100;

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * A split's share terms, from its adjustment factor when that is a ratio of
 * whole share counts: "10-for-1", "1-for-10 reverse", and, for one that adds
 * a share for every few held as a bonus issue does (DBS's 1-for-10 in 2024),
 * "11-for-10, 1 new share for every 10 held". Null for a factor no share count
 * states, which may be a spinoff's price adjustment rather than a split.
 */
export function splitShareTerms(split: Pick<SplitAction, "fromFactor" | "toFactor">): string | null {
  const { fromFactor: from, toFactor: to } = split;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from! <= 0 || to! <= 0 || from === to) return null;
  const divisor = greatestCommonDivisor(to!, from!);
  const after = to! / divisor;
  const before = from! / divisor;
  // One share for many (FFAI's 1-for-150 reverse split) is a split however many: an adjustment is never a whole 1:N.
  if (Math.min(after, before) !== 1 && Math.max(after, before) > MAX_SPLIT_SHARES) return null;
  if (after < before) return `${after}-for-${before} reverse`;
  if (before === 1) return `${after}-for-1`;
  const added = after - before;
  return `${after}-for-${before}, ${added} new share${added === 1 ? "" : "s"} for every ${before} held`;
}
