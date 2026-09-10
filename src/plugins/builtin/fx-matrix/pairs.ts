
export const MAJOR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
export type MajorCurrency = typeof MAJOR_CURRENCIES[number];

/** Preserve conventional quote precision and meaningful digits on inverse JPY crosses. */
export function formatRate(rate: number, toCurrency: string): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  const decimals = rate < 0.1 ? Math.min(8, 4 - Math.floor(Math.log10(rate))) : toCurrency === "JPY" ? 2 : 4;
  return rate.toFixed(decimals);
}

/**
 * The saved currency selection, falling back to the majors when it is empty or
 * holds codes this board does not carry.
 */
export function resolveCurrencies(saved?: readonly string[]): MajorCurrency[] {
  const resolved = (saved ?? []).filter(
    (code): code is MajorCurrency => MAJOR_CURRENCIES.includes(code as MajorCurrency),
  );
  return resolved.length > 0 ? resolved : [...MAJOR_CURRENCIES];
}
