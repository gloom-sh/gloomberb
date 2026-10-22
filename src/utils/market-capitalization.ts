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

/** A market cap a view shows, and when it is the share count times the price, the provider's figure it replaced. */
export interface ViewMarketCapitalization extends MarketCapitalization {
  /** Set when the cap shown is `shares` x `price` because the provider's sat more than 2% from it. */
  computed?: { shares: number; price: number; providerValue: number };
}

const positiveFinite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;

/**
 * The one market cap a view shows (GLO-1176): the provider's
 * (selectMarketCapitalization), unless it sits more than 2% from the share
 * count beside it times the price, when the view shows that product and
 * names the provider's in its note (`marketCapBasisNote`), so a cap and the
 * share count shown with it always tie and RV and `valuation` agree. `price`
 * is the price the view measures at (the regular session's); without a count
 * or a price in the cap's currency the provider's stands.
 */
export function viewMarketCapitalization(
  quote: Quote | undefined,
  fundamentals: Fundamentals | undefined,
  price: number | null | undefined = quote?.price,
): ViewMarketCapitalization | null {
  const selected = selectMarketCapitalization(quote, fundamentals);
  const shares = fundamentals?.sharesOutstanding;
  if (!selected || !(selected.value > 0) || selected.currency !== quote?.currency) return selected;
  if (!positiveFinite(shares) || !positiveFinite(price)) return selected;
  const product = shares * price;
  if (Math.abs(selected.value / product - 1) <= SHARE_COUNT_TOLERANCE) return selected;
  return {
    value: product,
    currency: selected.currency,
    // Priced at the quote, whichever block the provider's figure came from.
    provenance: { kind: "quote", source: quote.providerId },
    computed: { shares, price, providerValue: selected.value },
  };
}

/**
 * Where a view's market cap is the share count times the price rather than the provider's:
 * "Market cap 23.69B AUD is the 1.99B shares shown x 11.93 AUD; the provider's is 24.40B AUD."
 * Undefined when the provider's is shown.
 */
export function marketCapBasisNote(capitalization: ViewMarketCapitalization | null): string | undefined {
  const computed = capitalization?.computed;
  if (!capitalization || !computed) return undefined;
  const { currency } = capitalization;
  return `Market cap ${formatCompact(capitalization.value)} ${currency} is the ${formatCompact(computed.shares)} shares shown x ${formatNumber(computed.price, computed.price < 1 ? 4 : 2)} ${currency}; the provider's is ${formatCompact(computed.providerValue)} ${currency}.`;
}
