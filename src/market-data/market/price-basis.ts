import type { PriceBasis } from "../../types/instrument";

/** Legacy bond prices have no verified unit. Other existing asset contracts
 * remain currency-per-unit unless the source explicitly declares otherwise. */
export function resolvePriceBasis(basis: PriceBasis | null | undefined, assetCategory?: string): PriceBasis | null {
  if (basis === "per-unit" || basis === "percent-of-par" || basis === "points" || basis === "thirty-seconds") return basis;
  if (basis === null || assetCategory?.trim().toUpperCase() === "BOND") return null;
  return "per-unit";
}
