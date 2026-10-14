import type { Fundamentals, Quote } from "../types/financials";
import { formatCompact, formatNumber } from "./format";

export interface MarketCapitalization {
  value: number;
  currency: string;
  provenance: {
    kind: "quote" | "fundamentals";
    source?: string;
    retrievedAt?: string;
    stale?: boolean;
  };
}

function usableValue(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function explicitCurrency(currency: string | undefined): currency is string {
  return currency != null && /^[A-Z]{3}$/.test(currency);
}

/** A lightweight quote can omit capitalization without invalidating the snapshot. */
export function selectMarketCapitalization(
  quote: Quote | undefined,
  fundamentals: Fundamentals | undefined,
): MarketCapitalization | null {
  if (usableValue(quote?.marketCap) && explicitCurrency(quote?.currency)) {
    return { value: quote.marketCap, currency: quote.currency,
      provenance: { kind: "quote", source: quote.providerId } };
  }
  if (!usableValue(fundamentals?.marketCap) || !explicitCurrency(fundamentals?.marketCapCurrency)) return null;
  return { value: fundamentals.marketCap, currency: fundamentals.marketCapCurrency,
    provenance: { kind: "fundamentals", source: fundamentals.source,
      retrievedAt: fundamentals.fetchedAt, stale: fundamentals.stale } };
}

export function describeFundamentalMarketCap(provenance: MarketCapitalization["provenance"]): string {
  const source = provenance.source ?? "source unavailable";
  const parsed = provenance.retrievedAt ? Date.parse(provenance.retrievedAt) : NaN;
  const retrieval = Number.isFinite(parsed)
    ? `retrieved ${new Date(parsed).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}`
    : "retrieval time unavailable";
  return `${source} fundamentals, ${retrieval}${provenance.stale ? ", stale" : ""}; valuation date unavailable`;
}

export function convertMarketCapitalization(
  value: number | null,
  currency: string | null,
  baseCurrency: string,
  rates: ReadonlyMap<string, number>,
): number | null {
  if (value == null || !Number.isFinite(value) || !currency) return null;
  if (currency === baseCurrency) return value;
  const fromRate = currency === "USD" ? 1 : rates.get(currency);
  const toRate = baseCurrency === "USD" ? 1 : rates.get(baseCurrency);
  if (fromRate == null || toRate == null || !Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) return null;
  return value * fromRate / toRate;
}

/**
 * A capitalization a list can print. A venue that prices a contract rather than a company (a crypto-venue Brent
 * line) reports 0 for it, which is no capitalization: null, so it reads as none.
 */
export function listedMarketCapitalization(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** How far a market cap may sit from the share count times the price and still rest on that count. */
const SHARE_COUNT_TOLERANCE = 0.02;

/**
 * Where a market cap does not rest on the share count shown beside it (one class's count beside an all-class cap):
 * "Market cap 137.20B USD is the provider's and does not rest on the 799.93M shares shown (x 110.11 USD = 88.08B)."
 * Undefined when they tie, or without a count and a price in the cap's currency to test.
 */
export function marketCapShareBasisNote(
  capitalization: Pick<MarketCapitalization, "value" | "currency"> | null,
  shares: number | undefined,
  price: number | null | undefined,
  priceCurrency: string | undefined,
): string | undefined {
  if (!capitalization || !(capitalization.value > 0) || capitalization.currency !== priceCurrency) return undefined;
  if (shares == null || !Number.isFinite(shares) || !(shares > 0) || price == null || !Number.isFinite(price) || !(price > 0)) return undefined;
  const product = shares * price;
  if (Math.abs(capitalization.value / product - 1) <= SHARE_COUNT_TOLERANCE) return undefined;
  return `Market cap ${formatCompact(capitalization.value)} ${capitalization.currency} is the provider's and does not rest on the ${formatCompact(shares)} shares shown (x ${formatNumber(price, price < 1 ? 4 : 2)} ${priceCurrency} = ${formatCompact(product)}).`;
}
