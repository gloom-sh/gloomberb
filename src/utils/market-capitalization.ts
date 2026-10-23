import type { Fundamentals, Quote, SplitShareBasis } from "../types/financials";
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
 * How far a provider's cap may sit from the share count times the price and
 * still be on that count, off by price timing or a recent issuance (EVN:ASX,
 * 3% in October 2026). Past it the count is not the cap's: one class's count
 * beside an all-class cap (NRDY).
 */
const SHARE_BASIS_LIMIT = 0.1;

/** A market cap a view shows, and how it stands against the share count shown beside it. */
export interface ViewMarketCapitalization extends MarketCapitalization {
  /** Set when the cap shown is `shares` x `price` because the provider's sat more than 2% and at most 10% from it. */
  computed?: { shares: number; price: number; providerValue: number };
  /** Set when the provider's cap, shown, sits more than 10% from `shares` x `price`: the count is not the cap's. */
  otherBasis?: { shares: number; price: number; product: number };
  /** Set when a recent split put the share count and cap on the basis the listing trades on. */
  split?: SplitShareBasis;
}

const positiveFinite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value > 0;

/**
 * The one market cap a view shows, so RV and `valuation` agree:
 * the provider's (selectMarketCapitalization) while it is within 2% of the
 * share count beside it times the price; that product when the provider's
 * sits more than 2% and at most 10% from it (price timing, a recent
 * issuance), with the provider's named in the note; and the provider's again
 * past 10%, where the count shown is not the cap's (one class's beside an
 * all-class cap), with a note saying the two do not tie. `price` is
 * the price the view measures at (the regular session's); without a count or
 * a price in the cap's currency the provider's stands.
 */
export function viewMarketCapitalization(
  quote: Quote | undefined,
  fundamentals: Fundamentals | undefined,
  price: number | null | undefined = quote?.price,
): ViewMarketCapitalization | null {
  const capitalization = viewCapitalization(quote, fundamentals, price);
  const split = fundamentals?.splitShareBasis;
  return capitalization && split ? { ...capitalization, split } : capitalization;
}

function viewCapitalization(
  quote: Quote | undefined,
  fundamentals: Fundamentals | undefined,
  price: number | null | undefined,
): ViewMarketCapitalization | null {
  const selected = selectMarketCapitalization(quote, fundamentals);
  const shares = fundamentals?.sharesOutstanding;
  if (!selected || !(selected.value > 0) || selected.currency !== quote?.currency) return selected;
  if (!positiveFinite(shares) || !positiveFinite(price)) return selected;
  const product = shares * price;
  const gap = Math.abs(selected.value - product);
  if (gap <= SHARE_COUNT_TOLERANCE * product) return selected;
  if (gap > SHARE_BASIS_LIMIT * product) return { ...selected, otherBasis: { shares, price, product } };
  return {
    value: product,
    currency: selected.currency,
    // Priced at the quote, whichever block the provider's figure came from.
    provenance: { kind: "quote", source: quote.providerId },
    computed: { shares, price, providerValue: selected.value },
  };
}

/** "1-for-15 reverse split" for a price factor of 15, "10-for-1 split" for 0.1. */
function splitRatio(priceFactor: number): string {
  const ratio = (value: number) => String(Number(value.toPrecision(4)));
  return priceFactor >= 1 ? `1-for-${ratio(priceFactor)} reverse split` : `${ratio(1 / priceFactor)}-for-1 split`;
}

/**
 * What a view says when a recent split moved the share count shown:
 * - a filed count: "Shares outstanding are the 191.61M filed as of 2026-07-31, after the 1-for-15 reverse split on
 *   2026-08-19; the provider's market cap was 450.72M USD."
 * - the provider's cap: "Market cap is the provider's; its 191.61M share count predates the 1-for-15 reverse split on
 *   2026-08-19."
 */
function splitShareCountNote(split: SplitShareBasis, currency: string): string {
  const ratio = splitRatio(split.priceFactor);
  if (split.method === "provider_cap") {
    return `Market cap is the provider's; its ${formatCompact(split.reportedShares)} share count predates the ${ratio} on ${split.exDate}.`;
  }
  const filed = split.reportedAsOf ? ` filed as of ${split.reportedAsOf}` : " filed";
  const provider = split.providerMarketCap != null && split.providerMarketCap > 0
    ? `; the provider's market cap was ${formatCompact(split.providerMarketCap)} ${currency}` : "";
  return `Shares outstanding are the ${formatCompact(split.reportedShares)}${filed}, after the ${ratio} on ${split.exDate}${provider}.`;
}

/**
 * What a view says when its market cap and the share count shown beside it are not the provider's cap alone:
 * - the product shown: "Market cap 23.69B AUD is the 1.99B shares shown x 11.93 AUD; the provider's is 24.40B AUD."
 * - the provider's shown, on another count: "Market cap 79.11M USD is the provider's and does not rest on the
 *   72.23M shares shown (x 0.7133 USD = 51.52M)."
 * A recent split that moved the count is said first (splitShareCountNote).
 * Undefined when the provider's cap ties with the count and no split moved it.
 */
export function marketCapBasisNote(capitalization: ViewMarketCapitalization | null): string | undefined {
  if (!capitalization) return undefined;
  const { currency, split } = capitalization;
  const splitNote = split ? splitShareCountNote(split, currency) : undefined;
  const basisNote = shareBasisNote(capitalization);
  return splitNote && basisNote ? `${splitNote} ${basisNote}` : splitNote ?? basisNote;
}

function shareBasisNote(capitalization: ViewMarketCapitalization): string | undefined {
  const { currency, computed, otherBasis } = capitalization;
  const priced = (price: number) => `${formatNumber(price, price < 1 ? 4 : 2)} ${currency}`;
  if (computed) {
    return `Market cap ${formatCompact(capitalization.value)} ${currency} is the ${formatCompact(computed.shares)} shares shown x ${priced(computed.price)}; the provider's is ${formatCompact(computed.providerValue)} ${currency}.`;
  }
  if (otherBasis) {
    return `Market cap ${formatCompact(capitalization.value)} ${currency} is the provider's and does not rest on the ${formatCompact(otherBasis.shares)} shares shown (x ${priced(otherBasis.price)} = ${formatCompact(otherBasis.product)}).`;
  }
  return undefined;
}
