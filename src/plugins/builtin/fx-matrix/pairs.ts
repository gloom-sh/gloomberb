
export const MAJOR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
export type MajorCurrency = typeof MAJOR_CURRENCIES[number];

/** Format rate with appropriate precision — JPY pairs get 2 decimals, others get 4 */
export function formatRate(rate: number, toCurrency: string): string {
  const decimals = toCurrency === "JPY" ? 2 : 4;
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
