import type { AnalystResearchData, CorporateActionsData, Fundamentals, Quote } from "../../types/financials";
import { atRegularSessionPrice, regularSessionValuationPrice } from "./regular-session-valuation";
import { hasLikelyQuoteUnitMismatch, resolveCurrencyUnit } from "../../utils/currency-units";
import { cashInMajorUnits } from "../../utils/dividend-cash";
import { cashDistribution, dividendReferencePrice, trailingDividendYield, type CashDistribution } from "../../utils/trailing-dividend";
import { priceEarningsEps } from "../../utils/fundamentals";
import { selectMarketCapitalization, type MarketCapitalization } from "../../utils/market-capitalization";
import { priceEarningsOnEarnings, type PriceEarnings } from "../../utils/price-earnings";

/**
 * Price-derived statistics repriced at the quote's regular session price
 * (the live price while it trades, the close after it) with the base
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

interface LiveMarketCapitalization extends MarketCapitalization {
  /** Shares outstanding times the current price rather than a stored figure. */
  live: boolean;
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The price valuations follow: the regular session's, live while it trades
 * and its close after it, never a pre- or post-market print, even one the
 * quote's own price carries (regularSessionValuationPrice). */
function liveValuationPrice(quote: Quote | null | undefined): number | null {
  return regularSessionValuationPrice(quote);
}

/** A per-share base value shares the quote's basis only when the block's
 * currency is the quote's (major-unit) currency. Mirrors the served check. */
function sameCurrencyBasis(quote: Quote, fundamentals: Fundamentals): boolean {
  return !quote.currency || !fundamentals.marketCapCurrency || quote.currency === fundamentals.marketCapCurrency;
}

/** The served block with its price-derived figures moved to the regular session price, for when no base value reprices them. */
function pricedFundamentals(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): Fundamentals | undefined {
  return atRegularSessionPrice({ quote: quote ?? undefined, fundamentals }).fundamentals;
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

/**
 * Trailing P/E over the regular session price; not meaningful when the trailing EPS is zero or a loss. An EPS in another
 * currency than the price is repriced at the rate the served P/E converted it at.
 */
export function liveTrailingPE(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): PriceEarnings | undefined {
  const stored = pricedFundamentals(quote, fundamentals)?.trailingPE;
  return priceEarningsOnEarnings(repriceMultiple(stored, priceEarningsEps(fundamentals), quote, fundamentals), fundamentals?.eps);
}

/** Forward P/E over the regular session price; not meaningful when the forward EPS behind it is zero or a loss. */
export function liveForwardPE(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): PriceEarnings | undefined {
  const stored = pricedFundamentals(quote, fundamentals)?.forwardPE;
  return priceEarningsOnEarnings(repriceMultiple(stored, fundamentals?.forwardEps, quote, fundamentals), fundamentals?.forwardEps);
}

/** Forward dividend yield over the regular session price, as a ratio like the stored yield. */
export function liveDividendYield(quote: Quote | null | undefined, fundamentals: Fundamentals | undefined): number | undefined {
  const stored = pricedFundamentals(quote, fundamentals)?.dividendYield;
  const rate = fundamentals?.dividendRate;
  const price = liveValuationPrice(quote);
  if (price == null || !quote || !fundamentals || !positive(stored) || !positive(rate)) return stored;
  if (!sameCurrencyBasis(quote, fundamentals)) return stored;
  const drift = price / (rate / stored);
  if (drift > PRICE_DRIFT || drift < 1 / PRICE_DRIFT) return stored;
  return rate / price;
}

/** Whether a listing's yield is a trailing one, which is measured from its cash history (listingDividendYield). */
export function measuresTrailingYield(fundamentals: Pick<Fundamentals, "dividendYield" | "dividendYieldBasis"> | null | undefined): boolean {
  return fundamentals?.dividendYieldBasis === "trailing" && fundamentals.dividendYield != null;
}

/**
 * A trailing dividend yield as DVD measures it (trailingDividendYield): the
 * cash history's trailing twelve months over the quote's regular session
 * price, in the cash's currency. Null when the history cannot be read in full
 * (a row that is no paid distribution, no currency, dividends not covered) or
 * the price is in another currency, where DVD leaves its own blank.
 */
export function historyTrailingDividendYield(
  sourceActions: CorporateActionsData,
  quote: Quote | null | undefined,
  now = new Date(),
): number | null {
  const actions = cashInMajorUnits(sourceActions);
  const currency = resolveCurrencyUnit(actions.currency).currency;
  if (!currency || !Array.isArray(actions.dividends) || actions.coverage?.dividends === "unavailable") return null;
  if (actions.coverage?.dividends !== "available" && actions.dividends.length === 0) return null;
  const payments = actions.dividends.map((row) => cashDistribution(row.exDate, row.amount));
  if (payments.some((payment) => payment == null)) return null;
  const price = dividendReferencePrice(regularSessionValuationPrice(quote), quote?.currency, currency);
  return trailingDividendYield(payments as CashDistribution[], price, now);
}

/**
 * The dividend yield a listing shows at its regular session price. A trailing
 * one is DVD's, measured from `actions`, the listing's cash history
 * (historyTrailingDividendYield), so the overview, DIV% and DVD read one
 * figure; until that history is read, or when it cannot be read in full, it
 * is Gloom Cloud's, as a forward one is (liveDividendYield).
 */
export function listingDividendYield(
  quote: Quote | null | undefined,
  fundamentals: Fundamentals | undefined,
  actions: CorporateActionsData | null | undefined,
  now = new Date(),
): number | undefined {
  const measured = actions && measuresTrailingYield(fundamentals) ? historyTrailingDividendYield(actions, quote, now) : null;
  return measured ?? liveDividendYield(quote, fundamentals);
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
 * Market capitalization at the regular session price (the live price while it
 * trades, the close after it). The stored capitalization keeps
 * its currency; shares outstanding only replace it when they reproduce it at
 * a price the listing traded at, so a count for another class or listing
 * never scales the price.
 */
export function liveMarketCapitalization(
  quote: Quote | null | undefined,
  fundamentals: Fundamentals | undefined,
): LiveMarketCapitalization | null {
  // A stored cap is measured at the price served beside it; it moves to the regular session's like the rest.
  const priced = atRegularSessionPrice({ quote: quote ?? undefined, fundamentals });
  const stored = selectMarketCapitalization(priced.quote, priced.fundamentals);
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
 * The currency an analyst's targets are written in: the one the target or its
 * research names, whatever the quote's (a target in pounds under a quote in
 * pence stays in pounds). When neither names one, the quote's, but its major
 * unit when the quote is in a minor one (GBp, USX) and the target's reference
 * price, or the target itself, is a hundred times under the quote's price.
 */
export function analystTargetDisplayCurrency(
  analyst: AnalystResearchData | null | undefined,
  quoteCurrency: string,
  currentPrice: number | null | undefined,
): string {
  const named = analyst?.priceTarget?.currency?.trim() || analyst?.currency?.trim();
  if (named) return named;
  const unit = resolveCurrencyUnit(quoteCurrency);
  if (unit.divisor === 1 || !positive(currentPrice)) return quoteCurrency;
  const target = analyst?.priceTarget;
  const sample = [target?.current, target?.average, target?.median].find(positive);
  return sample != null && sample < currentPrice
    && hasLikelyQuoteUnitMismatch({ currency: quoteCurrency, price: sample }, { currency: quoteCurrency, price: currentPrice })
    ? unit.currency : quoteCurrency;
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
