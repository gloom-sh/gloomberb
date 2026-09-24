
export const MAJOR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;
export type MajorCurrency = typeof MAJOR_CURRENCIES[number];

/**
 * Preserve conventional quote precision and meaningful digits on inverse JPY
 * crosses. The digits are counted at `referenceRate` (the cross at a rate that
 * holds still) when there is one, so a live rate ticking across a power of ten,
 * such as JPY/AUD near 0.0100, keeps its decimals.
 */
export function formatRate(rate: number, toCurrency: string, referenceRate = rate): string {
  if (!Number.isFinite(rate) || rate <= 0) return "—";
  const basis = Number.isFinite(referenceRate) && referenceRate > 0 ? referenceRate : rate;
  const decimals = basis < 0.1 ? Math.min(8, 4 - Math.floor(Math.log10(basis))) : toCurrency === "JPY" ? 2 : 4;
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
