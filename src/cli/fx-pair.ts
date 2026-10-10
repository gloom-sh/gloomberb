/**
 * What `gloomberb fx` is asked for. A bare code is one unit of it in the base
 * currency (`NGN`: USD per 1 NGN). A pair is market convention, BASE/QUOTE:
 * `USD/NGN` is how many NGN one USD buys, and `ZAR/NGN` a cross of two codes
 * with neither in USD.
 */
export interface FxRequest {
  /** The currency one unit of which is priced: NGN in `NGN`, USD in `USD/NGN`. */
  currency: string;
  /** The currency the price is in: the base currency for a bare code, the quote of a pair. */
  baseCurrency: string;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** The request, or the sentence saying what is wrong with the argument. */
export function parseFxRequest(raw: string, baseCurrency: string): FxRequest | { error: string } {
  const text = raw.trim().toUpperCase();
  const parts = text.split("/").map((part) => part.trim());
  if (parts.length > 2 || parts.some((part) => !part)) return { error: `"${raw}" is not a currency or a pair such as USD/NGN.` };
  const bad = parts.filter((part) => !CURRENCY_CODE.test(part));
  if (bad.length > 0) return { error: `${bad.join(" and ")} ${bad.length > 1 ? "are not currency codes" : "is not a currency code"}; use three letters such as NGN.` };
  return parts.length === 2
    ? { currency: parts[0]!, baseCurrency: parts[1]! }
    : { currency: parts[0]!, baseCurrency: baseCurrency.trim().toUpperCase() };
}

/**
 * The rate of `currency` in `baseCurrency` from each one's USD value (USD per
 * unit), the way every cross is built. NaN when a leg is missing or unusable.
 */
export function crossRate(currencyInUsd: number | null | undefined, baseInUsd: number | null | undefined): number {
  if (!isUsableRate(currencyInUsd) || !isUsableRate(baseInUsd)) return Number.NaN;
  return currencyInUsd / baseInUsd;
}

export function isUsableRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A rate to six significant digits, so a tiny one keeps its figures
 * (0.000752791) and float noise goes; from 1000 up, to the cent (1328.39).
 * Never in exponent notation, and without trailing zeros.
 */
export function formatFxRate(rate: number): string {
  if (!Number.isFinite(rate)) return String(rate);
  const size = Math.abs(rate);
  const decimals = size >= 1000 || size === 0 ? 2 : Math.min(15, Math.max(0, 5 - Math.floor(Math.log10(size))));
  const fixed = rate.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Both directions on one line: `1 NGN = 0.000752791 USD  (USD/NGN 1328.39)`. */
export function describeFxRate(request: FxRequest, rate: number): string {
  return `1 ${request.currency} = ${formatFxRate(rate)} ${request.baseCurrency}  (${request.baseCurrency}/${request.currency} ${formatFxRate(1 / rate)})`;
}
