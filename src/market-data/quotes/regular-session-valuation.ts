import type { Fundamentals, Quote, TickerFinancials } from "../../types/financials";
import { priceEarningsEps } from "../../utils/fundamentals";
import { getRegularSessionDisplay } from "../market/status";

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The price a quote's valuation figures are read at: the regular session's,
 * as the headline reads it (getRegularSessionDisplay). While the session
 * trades it is the live price; after the close it is the close, so a
 * pre-market or after-hours print never moves a P/E, a market cap or a
 * yield. Null for a price quoted as a percent of par, which values no equity.
 */
export function regularSessionValuationPrice(quote: Quote | null | undefined): number | null {
  if (!quote || quote.priceBasis === "percent-of-par") return null;
  const price = getRegularSessionDisplay(quote)?.price;
  return positive(price) ? price : null;
}

function scaled(value: number | undefined, ratio: number): number | undefined {
  return value != null && Number.isFinite(value) ? value * ratio : value;
}

/** An amount in whole units of its currency, as sources serve a market cap or an enterprise value. */
function scaledAmount(value: number | undefined, ratio: number): number | undefined {
  const amount = scaled(value, ratio);
  return amount != null && Number.isFinite(amount) ? Math.round(amount) : amount;
}

/**
 * A fundamentals block's price-derived figures moved by `ratio`, a new price
 * over the price they were measured at: the trailing and forward P/E and the
 * market cap in `currency` (the quote's) move with it and the dividend yield
 * against it. Only the equity part of the enterprise value moves, by as much
 * as that cap does, and EV/Sales with it; with no cap in the quote's currency
 * to say how large that part is, both stay as served, as does a zero or
 * non-finite enterprise value (the source's gap). PEG stays as served.
 */
export function movePriceDerivedFigures(fundamentals: Fundamentals, currency: string | undefined, ratio: number): Fundamentals {
  const cap = fundamentals.marketCapCurrency === currency ? fundamentals.marketCap : undefined;
  const served = fundamentals.enterpriseValue;
  const enterpriseValue = served != null && Number.isFinite(served) && served !== 0 && cap != null && Number.isFinite(cap)
    ? Math.round(served + cap * (ratio - 1)) : served;
  const enterpriseValueRatio = positive(served) && positive(enterpriseValue) ? enterpriseValue / served : null;
  return {
    ...fundamentals,
    trailingPE: scaled(fundamentals.trailingPE, ratio),
    forwardPE: scaled(fundamentals.forwardPE, ratio),
    dividendYield: scaled(fundamentals.dividendYield, 1 / ratio),
    marketCap: cap != null ? scaledAmount(cap, ratio) : fundamentals.marketCap,
    enterpriseValue,
    enterpriseToRevenue: enterpriseValueRatio != null ? scaled(fundamentals.enterpriseToRevenue, enterpriseValueRatio) : fundamentals.enterpriseToRevenue,
  };
}

/**
 * How far from the quote's price a price implied by the served figures may
 * sit to be read as the one they were measured at: a print a few minutes
 * older than the quote. Further off, the per-share figure is on another basis
 * (another currency or share class), and the quote's own price is used.
 */
const MEASURED_PRICE_TOLERANCE = 0.03;

/**
 * The price the source measured its figures at. Gloom Cloud measures every
 * served figure at one price when it serves them, which can be a print older
 * than the quote beside them: the price its P/E times the EPS it divides
 * gives (then its forward P/E's, then its dividend yield's), when that sits
 * near the quote's price, otherwise the quote's price.
 */
function measuredAt(quote: Quote, fundamentals: Fundamentals | undefined): number {
  const product = (multiple: number | undefined, perShare: number | undefined) => (
    multiple != null && perShare != null ? multiple * perShare : undefined
  );
  const implied = fundamentals && fundamentals.stale !== true ? [
    product(fundamentals.trailingPE, priceEarningsEps(fundamentals)),
    product(fundamentals.forwardPE, fundamentals.forwardEps),
    fundamentals.dividendRate != null && positive(fundamentals.dividendYield) ? fundamentals.dividendRate / fundamentals.dividendYield : undefined,
  ] : [];
  return implied.find((price): price is number => positive(price) && Math.abs(price / quote.price - 1) <= MEASURED_PRICE_TOLERANCE) ?? quote.price;
}

/**
 * `financials` with every figure measured at a price moved to the quote's
 * regular session price (regularSessionValuationPrice): the quote's market
 * cap and the fundamentals' price-derived figures (movePriceDerivedFigures).
 * Gloom Cloud measures them at its latest print, which after the close is an
 * after-hours one and before the open a pre-market one, so they move to the
 * close and a P/E times its EPS is the close. While the session trades the
 * regular session price is the quote's and nothing moves. A stale quote, or
 * stale fundamentals (measured at some older price), are left as they are.
 */
export function atRegularSessionPrice<T extends Pick<TickerFinancials, "quote" | "fundamentals">>(financials: T): T {
  const quote = financials.quote;
  if (!quote || quote.stale || !positive(quote.price)) return financials;
  const price = regularSessionValuationPrice(quote);
  if (price == null || price === quote.price) return financials;
  const fundamentals = financials.fundamentals;
  const ratio = price / measuredAt(quote, fundamentals);
  return {
    ...financials,
    quote: { ...quote, marketCap: scaledAmount(quote.marketCap, ratio) },
    fundamentals: fundamentals && fundamentals.stale !== true ? movePriceDerivedFigures(fundamentals, quote.currency, ratio) : fundamentals,
  };
}
