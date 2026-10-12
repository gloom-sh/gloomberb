import type { Fundamentals, Quote } from "../types/financials";

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
