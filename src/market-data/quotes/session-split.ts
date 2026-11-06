import type { QuoteSessionSplit } from "../../types/financials";

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Gloom Cloud's `sessionSplit` when it reads as one; anything else is no split. */
export function readSessionSplit(value: unknown, divisor = 1): QuoteSessionSplit | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { exDate, priceFactor, sourcePreviousClose } = value as Record<string, unknown>;
  if (typeof exDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(exDate) || !positive(priceFactor) || priceFactor === 1
    || !positive(sourcePreviousClose)) return undefined;
  return { exDate, priceFactor, sourcePreviousClose: sourcePreviousClose / divisor };
}

/**
 * A split as shares before and after: "3-for-1" for a price factor of 1/3,
 * "1-for-10 reverse" for 10, "3-for-2" for 2/3. Null for a factor no pair of
 * whole share counts up to 1,000 gives.
 */
export function splitRatioText(priceFactor: number): string | null {
  if (!positive(priceFactor) || priceFactor === 1) return null;
  for (let before = 1; before <= 1000; before++) {
    const after = Math.round(before / priceFactor);
    if (after >= 1 && Math.abs((after * priceFactor) / before - 1) < 1e-6) {
      return `${after}-for-${before}${after < before ? " reverse" : ""}`;
    }
  }
  return null;
}
