import type { TickerRecord } from "../../../types/ticker";
import type { Quote } from "../../../types/financials";
import type { PriceBasis } from "../../../types/instrument";
import { resolvePriceBasis } from "../../../market-data/market/price-basis";
import { getActiveQuoteDisplay, type ActiveQuoteDisplay } from "../../../market-data/market/status";
import { resolveCurrencyUnit } from "../../../utils/currency-units";

export interface PortfolioPositionMetrics {
  positionCurrency: string;
  positionCount: number;
  hasShorts: boolean;
  totalShares: number;
  totalCost: number;
  /** Every nonzero lot has a finite source cost, independently of FX conversion. */
  hasCostBasis: boolean;
  /** Common source convention for displaying raw cost/mark; null is unknown or mixed. */
  priceBasis: PriceBasis | null;
  /** Signed cost basis, for net market value minus cost P&L. */
  signedCost: number;
  totalCostUnits: number;
  totalPriceUnits: number;
  grossPriceUnits: number;
  multiplierHint: number;
  /** Listed option contracts are valued at the two-sided midpoint when one is quoted. */
  valuesAtMark: boolean;
  brokerMktValue: number;
  brokerNetMktValue: number;
  hasBrokerMktValue: boolean;
  brokerPnl: number;
  hasBrokerPnl: boolean;
  brokerMarkPrice: number | undefined;
  pnlLots: { signedCost: number; priceUnits: number; direction: 1 | -1; brokerMarketValue: number | null; brokerPnl: number | null }[];
}

function normalizePositionMultiplier(multiplier: number | undefined): number {
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

export function signedPositionDirection(position: { shares: number; side?: "long" | "short" }): 1 | -1 {
  if (position.side === "short") return -1;
  if (position.side === "long") return 1;
  return position.shares < 0 ? -1 : 1;
}

export function resolvePositionCostMultiplier(position: TickerRecord["metadata"]["positions"][number]): number {
  const priceMultiplier = normalizePositionMultiplier(position.multiplier);
  if (priceMultiplier === 1) return 1;
  if (position.marketValue == null || position.unrealizedPnl == null
    || typeof position.avgCost !== "number" || !Number.isFinite(position.avgCost)) return priceMultiplier;

  const costWithoutMultiplier = Math.abs(position.shares) * position.avgCost;
  const costWithMultiplier = costWithoutMultiplier * priceMultiplier;
  const direction = signedPositionDirection(position);
  const marketValue = Math.abs(position.marketValue);
  const withoutMultiplierError = Math.abs(direction * (marketValue - costWithoutMultiplier) - position.unrealizedPnl);
  const withMultiplierError = Math.abs(direction * (marketValue - costWithMultiplier) - position.unrealizedPnl);
  // Some broker derivative feeds report avgCost already scaled to the contract.
  return withoutMultiplierError < withMultiplierError ? 1 : priceMultiplier;
}

export function getPortfolioPositionMetrics(
  ticker: TickerRecord,
  activeTab: string | undefined,
  fallbackCurrency: string,
  valuation?: { currency: string; convert: (value: number, currency: string) => number },
  /** Independent candidate quote: its convention must not come from stored cost/mark. */
  quote?: Quote | null,
): PortfolioPositionMetrics {
  const positions = ticker.metadata.positions.filter((position) =>
    (!activeTab || position.portfolio === activeTab) && position.shares !== 0,
  );
  const currencyFor = (position: typeof positions[number]) =>
    position.priceBasis === "percent-of-par" || ticker.metadata.assetCategory?.trim().toUpperCase() === "BOND"
      ? position.currency?.trim() || ticker.metadata.currency?.trim() || ""
      : position.currency || fallbackCurrency;
  const currencies = new Set(positions.map(currencyFor));
  const bases = new Set(positions.map(position => resolvePriceBasis(position.priceBasis, ticker.metadata.assetCategory)));
  const priceBasis = bases.size === 0 ? resolvePriceBasis(undefined, ticker.metadata.assetCategory) : bases.size === 1 ? [...bases][0]! : null;
  const positionCurrency = valuation?.currency ?? (currencies.size > 1 ? "Mixed" : [...currencies][0] ?? fallbackCurrency);
  const convert = (value: number, position: typeof positions[number]) => {
    const currency = currencyFor(position);
    if (!currency) return Number.NaN;
    return valuation ? valuation.convert(value, currency) : currencies.size > 1 ? Number.NaN : value;
  };
  const metrics: PortfolioPositionMetrics = {
    positionCurrency, positionCount: positions.length, hasShorts: false,
    totalShares: 0, totalCost: 0, hasCostBasis: positions.length > 0, priceBasis, signedCost: 0, totalCostUnits: 0,
    totalPriceUnits: 0, grossPriceUnits: 0, multiplierHint: 1,
    valuesAtMark: ticker.metadata.assetCategory?.trim().toUpperCase() === "OPT",
    brokerMktValue: 0, brokerNetMktValue: 0, hasBrokerMktValue: positions.length > 0,
    brokerPnl: 0, hasBrokerPnl: positions.length > 0,
    brokerMarkPrice: positions.length === 1 && priceBasis ? positions[0]?.markPrice : undefined,
    pnlLots: [],
  };
  for (const position of positions) {
    const direction = signedPositionDirection(position);
    const magnitude = Math.abs(position.shares);
    const basis = resolvePriceBasis(position.priceBasis, ticker.metadata.assetCategory);
    const contractMultiplier = normalizePositionMultiplier(position.multiplier);
    // Nominal face already includes the amount held. Keep the supplied contract
    // multiplier as metadata; it must not scale percent-of-par money again.
    const priceMultiplier = basis === "percent-of-par" ? .01 : basis === "per-unit" ? contractMultiplier : Number.NaN;
    const costMultiplier = basis === "percent-of-par" ? .01 : basis === "per-unit" ? resolvePositionCostMultiplier(position) : Number.NaN;
    const quoteBasis = quote ? resolvePriceBasis(quote.priceBasis,
      basis === "percent-of-par" || ticker.metadata.assetCategory?.toUpperCase() === "BOND" ? "BOND" : quote.instrumentType) : basis;
    const nominalCurrency = resolveCurrencyUnit(currencyFor(position));
    const quoteCurrency = resolveCurrencyUnit(quote?.currency || "");
    const compatiblePar = !quote || quoteBasis !== "percent-of-par"
      || basis === "percent-of-par" && !!nominalCurrency.currency
        && nominalCurrency.currency === quoteCurrency.currency && nominalCurrency.divisor === quoteCurrency.divisor;
    const quoteMultiplier = basis === null || quoteBasis === null || !compatiblePar ? Number.NaN
      : quoteBasis === "percent-of-par" ? .01 : basis === "percent-of-par" ? 1 : contractMultiplier;
    const hasCost = basis !== null && !!currencyFor(position) && typeof position.avgCost === "number" && Number.isFinite(position.avgCost);
    const cost = hasCost ? magnitude * position.avgCost! * costMultiplier : Number.NaN;
    metrics.hasCostBasis &&= hasCost;
    metrics.hasShorts ||= direction < 0;
    metrics.multiplierHint = Math.max(metrics.multiplierHint, contractMultiplier);
    metrics.totalShares += magnitude * direction;
    metrics.totalCost += convert(cost, position);
    metrics.signedCost += direction * convert(cost, position);
    metrics.totalCostUnits += magnitude * costMultiplier;
    metrics.totalPriceUnits += magnitude * quoteMultiplier * direction;
    metrics.grossPriceUnits += magnitude * quoteMultiplier;

    // Normalize each lot before summing: broker values may be signed, and a
    // complete snapshot for one account cannot stand in for another missing lot.
    const marketValue = Number.isFinite(position.marketValue) ? Math.abs(position.marketValue!)
      : Number.isFinite(position.markPrice) && Number.isFinite(priceMultiplier) ? magnitude * priceMultiplier * position.markPrice!
      : Number.isFinite(position.unrealizedPnl) && Number.isFinite(cost) ? cost + direction * position.unrealizedPnl!
      : null;
    const pnl = Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl!
      : marketValue != null && Number.isFinite(cost) ? direction * (marketValue - cost) : null;
    if (marketValue == null || !Number.isFinite(marketValue)) metrics.hasBrokerMktValue = false;
    else {
      metrics.brokerMktValue += convert(marketValue, position);
      metrics.brokerNetMktValue += direction * convert(marketValue, position);
    }
    if (pnl == null || !Number.isFinite(pnl)) metrics.hasBrokerPnl = false;
    else metrics.brokerPnl += convert(pnl, position);
    metrics.pnlLots.push({
      signedCost: direction * convert(cost, position),
      priceUnits: magnitude * quoteMultiplier * direction,
      direction,
      brokerMarketValue: marketValue != null && Number.isFinite(marketValue) ? convert(marketValue, position) : null,
      brokerPnl: pnl != null && Number.isFinite(pnl) ? convert(pnl, position) : null,
    });
  }
  return metrics;
}

/**
 * A thin contract's last print can be hours old while its market moves; the
 * midpoint of a two-sided quote is the mark, against the same prior close.
 * A last inside the market, or a print known to predate the quote, yields to
 * the mark. A last outside a market of unknown age keeps the last: the bid and
 * ask may be the leftovers, not the print.
 */
function optionMarkDisplay(quote: Quote, active: ActiveQuoteDisplay): ActiveQuoteDisplay | null {
  const { bid, ask } = quote;
  if (typeof bid !== "number" || typeof ask !== "number" || !Number.isFinite(bid) || !Number.isFinite(ask)
    || bid < 0 || ask <= 0 || ask < bid) return null;
  const printInsideMarket = active.price >= bid && active.price <= ask;
  const printPredatesQuote = typeof quote.lastTradeTime === "number" && Number.isFinite(quote.lastTradeTime)
    && quote.lastTradeTime < quote.lastUpdated;
  if (!printInsideMarket && !printPredatesQuote) return null;
  const mark = (bid + ask) / 2;
  const reference = typeof active.change === "number" && Number.isFinite(active.change)
    ? active.price - active.change : quote.previousClose;
  if (reference == null || !Number.isFinite(reference)) return { price: mark };
  const change = mark - reference;
  return { price: mark, change, changePercent: reference > 0 ? change / reference * 100 : undefined };
}

/** Only a compatible, finite quote may replace independently usable broker
 * totals. This is the valuation price: an option's mark rather than its last. */
export function getPortfolioQuoteDisplay(metrics: PortfolioPositionMetrics, quote: Quote | null | undefined): ActiveQuoteDisplay | null {
  const displayed = getActiveQuoteDisplay(quote);
  const active = displayed && metrics.valuesAtMark ? optionMarkDisplay(quote!, displayed) ?? displayed : displayed;
  return active && Number.isFinite(active.price)
    && (metrics.positionCount === 0 || metrics.pnlLots.some(lot => Number.isFinite(lot.priceUnits))) ? active : null;
}

/** Select compatible current prices or independent snapshot totals per lot. */
export function resolvePortfolioMarketValue(metrics: PortfolioPositionMetrics, currentUnitPrice?: number | null): { gross: number; net: number } | null {
  if (metrics.positionCount === 0) return null;
  let gross = 0;
  let net = 0;
  for (const lot of metrics.pnlLots) {
    const current = currentUnitPrice != null && Number.isFinite(currentUnitPrice)
      ? Math.abs(lot.priceUnits) * currentUnitPrice : Number.NaN;
    const value = Number.isFinite(current) ? current : lot.brokerMarketValue;
    if (value === null || !Number.isFinite(value)) return null;
    gross += value;
    net += lot.direction * value;
  }
  return Number.isFinite(gross) && Number.isFinite(net) ? { gross, net } : null;
}

export function resolveBrokerFallbackMarketValue(metrics: PortfolioPositionMetrics): number | null {
  return metrics.hasBrokerMktValue && Number.isFinite(metrics.brokerMktValue) ? metrics.brokerMktValue : null;
}

export function resolveBrokerFallbackPnl(metrics: PortfolioPositionMetrics, _brokerMarketValue?: number | null): number | null {
  return metrics.hasBrokerPnl && Number.isFinite(metrics.brokerPnl) ? metrics.brokerPnl : null;
}

export interface PortfolioPositionPnl {
  value: number | null;
  basis: "quote-and-cost" | "broker-snapshot" | "mixed" | "unavailable";
}

export function portfolioPnlLabel(bases: Iterable<PortfolioPositionPnl["basis"]>): string {
  const sources = new Set(bases);
  if (sources.has("mixed") || (sources.has("broker-snapshot") && sources.has("quote-and-cost"))) return "Mixed P&L";
  return sources.has("broker-snapshot") ? "Broker P&L" : "P&L";
}

/** A current quote cannot establish missing acquisition cost or refresh a broker P&L snapshot. */
export function resolvePortfolioPositionPnl(
  metrics: PortfolioPositionMetrics,
  currentUnitPrice?: number | null,
): PortfolioPositionPnl {
  if (metrics.pnlLots.length === 0) return { value: null, basis: "unavailable" };
  let total = 0;
  const bases = new Set<"quote-and-cost" | "broker-snapshot">();
  for (const lot of metrics.pnlLots) {
    const currentPnl = typeof currentUnitPrice === "number" && Number.isFinite(currentUnitPrice)
      ? currentUnitPrice * lot.priceUnits - lot.signedCost : Number.NaN;
    if (Number.isFinite(currentPnl)) {
      total += currentPnl;
      bases.add("quote-and-cost");
    } else if (lot.brokerPnl !== null && Number.isFinite(lot.brokerPnl)) {
      total += lot.brokerPnl;
      bases.add("broker-snapshot");
    } else return { value: null, basis: "unavailable" };
  }
  return Number.isFinite(total)
    ? { value: total, basis: bases.size > 1 ? "mixed" : [...bases][0]! }
    : { value: null, basis: "unavailable" };
}

export function portfolioPnlPercent(value: number | null, costBasis: number): number | null {
  const percent = value !== null && Number.isFinite(value) && Number.isFinite(costBasis) && costBasis !== 0
    ? value / costBasis * 100 : Number.NaN;
  return Number.isFinite(percent) ? percent : null;
}
