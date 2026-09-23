import type { AnalystResearchData, Fundamentals, Quote } from "../../../types/financials";
import { hasLikelyQuoteUnitMismatch } from "../../../utils/currency-units";
import { selectMarketCapitalization, type MarketCapitalization } from "../../../utils/market-capitalization";

/**
 * Price-derived statistics repriced from the current quote with the base
 * values the server serves beside them (shares outstanding, EPS, dividend
 * rate). Each one falls back to its stored snapshot whenever the base value
 * cannot be shown to be on the quote's listing, currency and unit.
 */

/** The server's bound for repricing a served trailing P/E: beyond it the source
 * multiple is on another share class or currency unit, not a few days old. */
const PRICE_DRIFT = 1.5;
/** The server's close-basis tolerance: a capitalization's implied share price
 * must sit this close to a price the listing traded at before its share count
 * is trusted to scale the quote. */
const PRICE_BASIS = 0.005;

/** Optional base values; used only when the served block carries them. */
type ValuationFundamentals = Fundamentals & { forwardEps?: number; dividendRate?: number };

interface LiveMarketCapitalization extends MarketCapitalization {
  /** Shares outstanding times the current price rather than a stored figure. */
  live: boolean;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The price valuations follow: the quote's own price, as the server reprices
 * served statistics, rather than a separate pre- or post-market print. */
function liveValuationPrice(quote: Quote | null | undefined): number | null {
  if (!quote || quote.priceBasis === "percent-of-par") return null;
  return positive(quote.price) ? quote.price : null;
}

/** A per-share base value shares the quote's basis only when the block's
 * currency is the quote's (major-unit) currency. Mirrors the served check. */
function sameCurrencyBasis(quote: Quote, fundamentals: Fundamentals): boolean {
  return !quote.currency || !fundamentals.marketCapCurrency || quote.currency === fundamentals.marketCapCurrency;
}

function repriceMultiple(
  multiple: number | undefined,
  perShare: number | undefined,
  quote: Quote | null | undefined,
  fundamentals: Fundamentals | undefined,
): number | undefined {
  const price = liveValuationPrice(quote);
  if (price == null || !quote || !fundamentals || !positive(multiple) || !positive(perShare)) return multiple;
  if (!sameCurrencyBasis(quote, fundamentals)) return multiple;
  const drift = price / (multiple * perShare);
  if (drift > PRICE_DRIFT || drift < 1 / PRICE_DRIFT) return multiple;
  return price / perShare;
}

/** Trailing P/E over the current price. Zero or negative EPS keeps the stored multiple. */
export function liveTrailingPE(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): number | undefined {
  return repriceMultiple(fundamentals?.trailingPE, fundamentals?.eps, quote, fundamentals);
}

export function liveForwardPE(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): number | undefined {
  return repriceMultiple(fundamentals?.forwardPE, (fundamentals as ValuationFundamentals | undefined)?.forwardEps, quote, fundamentals);
}

/** Forward dividend yield over the current price, as a ratio like the stored yield. */
export function liveDividendYield(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): number | undefined {
  const stored = fundamentals?.dividendYield;
  const rate = (fundamentals as ValuationFundamentals | undefined)?.dividendRate;
  const price = liveValuationPrice(quote);
  if (price == null || !quote || !fundamentals || !positive(stored) || !positive(rate)) return stored;
  if (!sameCurrencyBasis(quote, fundamentals)) return stored;
  const drift = price / (rate / stored);
  if (drift > PRICE_DRIFT || drift < 1 / PRICE_DRIFT) return stored;
  return rate / price;
}

/**
 * Whether a capitalization's implied share price is one this listing traded
 * at: the prior close (a source capitalization) or anywhere in the session
 * range (one repriced when it was served), within the server's tolerance.
 * META's class A count implies 851 against a 747 close and fails; so does an
 * ADR count off by its ratio.
 */
function impliedPriceOnListing(implied: number, quote: Quote): boolean {
  const anchors = [quote.previousClose, quote.low, quote.high].filter(positive);
  if (anchors.length === 0) return false;
  return implied >= Math.min(...anchors) * (1 - PRICE_BASIS)
    && implied <= Math.max(...anchors) * (1 + PRICE_BASIS);
}

/**
 * Market capitalization at the current price. The stored capitalization keeps
 * its currency; shares outstanding only replace it when they reproduce it at
 * a price the listing traded at, so a count for another class or listing
 * never scales the price.
 */
export function liveMarketCapitalization(
  quote: Quote | null | undefined,
  fundamentals: Fundamentals | undefined,
): LiveMarketCapitalization | null {
  const stored = selectMarketCapitalization(quote ?? undefined, fundamentals);
  if (!stored) return null;
  const price = liveValuationPrice(quote);
  const shares = fundamentals?.sharesOutstanding;
  if (!quote || price == null || !positive(shares) || !positive(stored.value) || stored.currency !== quote.currency) {
    return { ...stored, live: false };
  }
  if (!impliedPriceOnListing(stored.value / shares, quote)) return { ...stored, live: false };
  return { ...stored, value: shares * price, live: true };
}

/**
 * The 52-week extremes with today's session folded in, so a new high or low
 * reads 100% or 0% instead of pinning against a stale bound. A caller that
 * positions a pre- or post-market price passes it so the range contains it.
 */
export function liveFiftyTwoWeekRange(
  quote: Quote | null | undefined,
  displayedPrice?: number | null,
): { low: number; high: number } | null {
  if (!quote || !positive(quote.low52w) || !positive(quote.high52w)) return null;
  const session = [quote.price, quote.high, quote.low, displayedPrice].filter(positive);
  const low = Math.min(quote.low52w, ...session);
  const high = Math.max(quote.high52w, ...session);
  return high > low ? { low, high } : null;
}

/**
 * The price an analyst target is compared with. The current price when the
 * target is quoted in the listing's currency; otherwise the research snapshot's
 * own price, which is on the target's basis.
 */
export function targetReferencePrice(
  analyst: AnalystResearchData | null | undefined,
  quoteCurrency: string,
  currentPrice: number | null | undefined,
): number | null {
  const snapshot = analyst?.priceTarget?.current;
  const snapshotPrice = positive(snapshot) ? snapshot : null;
  const targetCurrency = analyst?.priceTarget?.currency ?? analyst?.currency;
  if (!positive(currentPrice)) return snapshotPrice;
  if (targetCurrency && targetCurrency !== quoteCurrency) return snapshotPrice;
  if (snapshotPrice != null && hasLikelyQuoteUnitMismatch(
    { currency: quoteCurrency, price: snapshotPrice },
    { currency: quoteCurrency, price: currentPrice },
  )) return snapshotPrice;
  return currentPrice;
}
