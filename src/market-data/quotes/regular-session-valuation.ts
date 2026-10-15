import type { EnterpriseValueCheck, Fundamentals, Quote, TickerFinancials } from "../../types/financials";
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

/** How far each price-derived figure moves: the ratio of the new price to the one it was measured at. */
interface FigureMoves {
  trailingPE: number;
  forwardPE: number;
  dividendYield: number;
  marketCap: number;
  /** The move from the price the enterprise value's equity part was measured at. */
  enterpriseValue: number;
}

/**
 * The served EV check at the moved figures, so its note reads the EV and the
 * market cap the rows show: the EV it describes is the moved one, and the
 * computed EV moves with the cap. A withdrawn EV, shown nowhere, moves with
 * the cap as the computed one does. The status stays the one Gloom Cloud
 * judged.
 */
function movedEnterpriseValueCheck(
  check: EnterpriseValueCheck | undefined,
  served: number | undefined,
  enterpriseValue: number | undefined,
  movedCap: number | undefined,
): EnterpriseValueCheck | undefined {
  if (!check || movedCap == null || !Number.isFinite(movedCap) || !Number.isFinite(check.marketCap)) return check;
  const shift = movedCap - check.marketCap;
  if (shift === 0 && served === enterpriseValue) return check;
  const source = check.status !== "withdrawn" && served === check.source && enterpriseValue != null
    ? enterpriseValue
    : check.source + shift;
  return {
    ...check,
    source,
    marketCap: movedCap,
    ...(check.computed != null && Number.isFinite(check.computed) ? { computed: check.computed + shift } : {}),
  };
}

function moveFigures(fundamentals: Fundamentals, currency: string | undefined, moves: FigureMoves): Fundamentals {
  const cap = fundamentals.marketCapCurrency === currency ? fundamentals.marketCap : undefined;
  const movedCap = cap != null ? scaledAmount(cap, moves.marketCap) : undefined;
  const served = fundamentals.enterpriseValue;
  // Only the equity part of the enterprise value moves: from the cap at the price it was measured at to the moved cap.
  const enterpriseValue = served != null && Number.isFinite(served) && served !== 0 && movedCap != null && Number.isFinite(movedCap)
    ? Math.round(served + movedCap * (1 - 1 / moves.enterpriseValue)) : served;
  const enterpriseValueRatio = positive(served) && positive(enterpriseValue) ? enterpriseValue / served : null;
  const check = fundamentals.enterpriseValueCheck?.currency === currency
    ? movedEnterpriseValueCheck(fundamentals.enterpriseValueCheck, served, enterpriseValue, movedCap)
    : fundamentals.enterpriseValueCheck;
  return {
    ...fundamentals,
    ...(check ? { enterpriseValueCheck: check } : {}),
    trailingPE: scaled(fundamentals.trailingPE, moves.trailingPE),
    forwardPE: scaled(fundamentals.forwardPE, moves.forwardPE),
    dividendYield: scaled(fundamentals.dividendYield, 1 / moves.dividendYield),
    marketCap: cap != null ? movedCap : fundamentals.marketCap,
    enterpriseValue,
    enterpriseToRevenue: enterpriseValueRatio != null ? scaled(fundamentals.enterpriseToRevenue, enterpriseValueRatio) : fundamentals.enterpriseToRevenue,
  };
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
  return moveFigures(fundamentals, currency, { trailingPE: ratio, forwardPE: ratio, dividendYield: ratio, marketCap: ratio, enterpriseValue: ratio });
}

/**
 * How far from the prices around it (the quote's and the regular session's)
 * a price implied by a served figure may sit to be read as the one it was
 * measured at: a print a few minutes older than the quote, or the close.
 * Further off, the per-share figure is on another basis (another currency or
 * share class), and the figure is read as measured at the quote's price.
 */
const MEASURED_PRICE_TOLERANCE = 0.03;

/**
 * `financials` with every figure measured at a price moved to the quote's
 * regular session price (regularSessionValuationPrice): the quote's market
 * cap and the fundamentals' price-derived figures, as movePriceDerivedFigures
 * moves them. Gloom Cloud measures them at a recent print, which after the
 * close is an after-hours one and before the open a pre-market one, and not
 * always the same print for each figure (a cap can already be the close's
 * while the P/E is the print's), so each moves from the price its own
 * per-share base implies: P/E times EPS, forward P/E times forward EPS, the
 * dividend rate over the yield, the cap over the shares outstanding; the
 * enterprise value, which has none, from the multiples' price. Without one, a
 * figure is read as measured at the quote's price. A P/E times its EPS
 * is then the close. While the session trades the regular session price is
 * the quote's and nothing moves. A stale quote, or stale fundamentals
 * (measured at some older price), are left as they are.
 */
export function atRegularSessionPrice<T extends Pick<TickerFinancials, "quote" | "fundamentals">>(financials: T): T {
  const quote = financials.quote;
  if (!quote || quote.stale || !positive(quote.price)) return financials;
  const price = regularSessionValuationPrice(quote);
  if (price == null || price === quote.price) return financials;
  const low = Math.min(price, quote.price) * (1 - MEASURED_PRICE_TOLERANCE);
  const high = Math.max(price, quote.price) * (1 + MEASURED_PRICE_TOLERANCE);
  /** The price a figure was measured at, when the one its per-share base implies is near enough to be it. */
  const near = (implied: number | undefined) => (positive(implied) && implied >= low && implied <= high ? implied : undefined);
  const moveFrom = (implied: number | undefined) => price / (near(implied) ?? quote.price);
  const per = (value: number | undefined, base: number | undefined) => (value != null && base != null ? value * base : undefined);
  const fundamentals = financials.fundamentals;
  const shares = fundamentals?.sharesOutstanding;
  const capMove = (cap: number | undefined) => moveFrom(positive(cap) && positive(shares) ? cap / shares : undefined);
  if (!fundamentals || fundamentals.stale === true) {
    return { ...financials, quote: { ...quote, marketCap: scaledAmount(quote.marketCap, capMove(quote.marketCap)) } };
  }
  const trailing = per(fundamentals.trailingPE, priceEarningsEps(fundamentals));
  const forward = per(fundamentals.forwardPE, fundamentals.forwardEps);
  const dividend = fundamentals.dividendRate != null && positive(fundamentals.dividendYield)
    ? fundamentals.dividendRate / fundamentals.dividendYield : undefined;
  return {
    ...financials,
    quote: { ...quote, marketCap: scaledAmount(quote.marketCap, capMove(quote.marketCap)) },
    fundamentals: moveFigures(fundamentals, quote.currency, {
      trailingPE: moveFrom(trailing),
      forwardPE: moveFrom(forward),
      dividendYield: moveFrom(dividend),
      marketCap: capMove(fundamentals.marketCap),
      enterpriseValue: moveFrom(near(trailing) ?? near(forward) ?? near(dividend)),
    }),
  };
}
