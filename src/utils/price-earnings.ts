import { formatNumber } from "./format";

export const PRICE_EARNINGS_NOTICE = "N/M = not meaningful. Non-positive P/E values are excluded from ranking.";

/** Negative earnings do not make a security cheaper than a profitable peer. */
export function comparablePriceEarnings(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

export function formatPriceEarnings(value: number | null | undefined, precision = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value <= 0 ? "N/M" : formatNumber(value, precision);
}
