import { resolveCurrencyUnit } from "./currency-units";
import { formatCompact, formatCurrency, formatCurrencyCode, formatNumber } from "./format";

function perShareDecimals(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude > 0 && magnitude < 1 ? Math.max(2, 3 - Math.floor(Math.log10(magnitude))) : 2;
}

function usesScientificNotation(value: number): boolean {
  return value !== 0 && Math.abs(value) < 0.0001;
}

/** Preserve small profits and losses without widening ordinary EPS cells. */
export function formatPerShareNumber(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (usesScientificNotation(value)) return value.toExponential(3).replace(/\.?0+e/, "e");
  return formatNumber(value === 0 ? 0 : value, perShareDecimals(value)).replace(/(\.\d{2}.*?)0+$/, "$1");
}

/**
 * Keep reported monetary amounts in their own units, independently of a
 * quote. A per-share amount reads with its sign ($6.54), or with `code` its
 * code (6.54 USD) as every other amount does.
 */
export function formatReportedMoney(value: number | undefined, currency?: string, perShare = false, code = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const amount = perShare ? formatPerShareNumber(value) : formatCompact(value);
  const unit = currency?.trim();
  if (!unit) return `${amount} (ccy?)`;
  // Intl uppercases currency codes: GBp must not become GBP without scaling.
  if (perShare && !usesScientificNotation(value) && /^[a-z]{3}$/i.test(unit) && resolveCurrencyUnit(unit).divisor === 1) {
    return (code ? formatCurrencyCode : formatCurrency)(value === 0 ? 0 : value, unit, perShareDecimals(value));
  }
  return `${amount} ${unit}`;
}
