import type { TickerRecord } from "../../../types/ticker";

export interface PortfolioPositionMetrics {
  positionCurrency: string;
  positionCount: number;
  hasShorts: boolean;
  totalShares: number;
  totalCost: number;
  /** Signed cost basis, for net market value minus cost P&L. */
  signedCost: number;
  totalCostUnits: number;
  totalPriceUnits: number;
  grossPriceUnits: number;
  multiplierHint: number;
  brokerMktValue: number;
  brokerNetMktValue: number;
  hasBrokerMktValue: boolean;
  brokerPnl: number;
  hasBrokerPnl: boolean;
  brokerMarkPrice: number | undefined;
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
  if (position.marketValue == null || position.unrealizedPnl == null) return priceMultiplier;

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
): PortfolioPositionMetrics {
  const positions = ticker.metadata.positions.filter((position) =>
    (!activeTab || position.portfolio === activeTab) && position.shares !== 0,
  );
  const currencies = new Set(positions.map((position) => position.currency || fallbackCurrency));
  const positionCurrency = valuation?.currency ?? (currencies.size > 1 ? "Mixed" : [...currencies][0] || fallbackCurrency);
  const convert = (value: number, position: typeof positions[number]) => valuation
    ? valuation.convert(value, position.currency || fallbackCurrency)
    : currencies.size > 1 ? Number.NaN : value;
  const metrics: PortfolioPositionMetrics = {
    positionCurrency, positionCount: positions.length, hasShorts: false,
    totalShares: 0, totalCost: 0, signedCost: 0, totalCostUnits: 0,
    totalPriceUnits: 0, grossPriceUnits: 0, multiplierHint: 1,
    brokerMktValue: 0, brokerNetMktValue: 0, hasBrokerMktValue: positions.length > 0,
    brokerPnl: 0, hasBrokerPnl: positions.length > 0,
    brokerMarkPrice: positions.length === 1 ? positions[0]?.markPrice : undefined,
  };
  for (const position of positions) {
    const direction = signedPositionDirection(position);
    const magnitude = Math.abs(position.shares);
    const priceMultiplier = normalizePositionMultiplier(position.multiplier);
    const costMultiplier = resolvePositionCostMultiplier(position);
    const cost = magnitude * position.avgCost * costMultiplier;
    metrics.hasShorts ||= direction < 0;
    metrics.multiplierHint = Math.max(metrics.multiplierHint, priceMultiplier, costMultiplier);
    metrics.totalShares += magnitude * direction;
    metrics.totalCost += convert(cost, position);
    metrics.signedCost += direction * convert(cost, position);
    metrics.totalCostUnits += magnitude * costMultiplier;
    metrics.totalPriceUnits += magnitude * priceMultiplier * direction;
    metrics.grossPriceUnits += magnitude * priceMultiplier;

    // Normalize each lot before summing: broker values may be signed, and a
    // complete snapshot for one account cannot stand in for another missing lot.
    const marketValue = Number.isFinite(position.marketValue) ? Math.abs(position.marketValue!)
      : Number.isFinite(position.markPrice) ? magnitude * priceMultiplier * position.markPrice!
      : Number.isFinite(position.unrealizedPnl) ? cost + direction * position.unrealizedPnl!
      : null;
    const pnl = Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl!
      : marketValue != null ? direction * (marketValue - cost) : null;
    if (marketValue == null) metrics.hasBrokerMktValue = false;
    else {
      metrics.brokerMktValue += convert(marketValue, position);
      metrics.brokerNetMktValue += direction * convert(marketValue, position);
    }
    if (pnl == null) metrics.hasBrokerPnl = false;
    else metrics.brokerPnl += convert(pnl, position);
  }
  return metrics;
}

export function resolveBrokerFallbackMarketValue(metrics: PortfolioPositionMetrics): number | null {
  return metrics.hasBrokerMktValue ? metrics.brokerMktValue : null;
}

export function resolveBrokerFallbackPnl(metrics: PortfolioPositionMetrics, _brokerMarketValue?: number | null): number | null {
  return metrics.hasBrokerPnl ? metrics.brokerPnl : null;
}
