import type { TickerRecord } from "../../../types/ticker";

export interface PortfolioPositionMetrics {
  positionCurrency: string;
  totalShares: number;
  totalCost: number;
  totalCostUnits: number;
  totalPriceUnits: number;
  multiplierHint: number;
  brokerMktValue: number;
  hasBrokerMktValue: boolean;
  brokerPnl: number;
  hasBrokerPnl: boolean;
  brokerMarkPrice: number | undefined;
}

function getPositionCurrency(
  positions: TickerRecord["metadata"]["positions"],
  fallbackCurrency: string,
): string {
  return positions.find((position) => position.currency)?.currency || fallbackCurrency;
}

function normalizePositionMultiplier(multiplier: number | undefined): number {
  return typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0
    ? multiplier
    : 1;
}

export function signedPositionDirection(position: {
  shares: number;
  side?: "long" | "short";
}): 1 | -1 {
  if (position.side === "short") return -1;
  if (position.side === "long") return 1;
  return position.shares < 0 ? -1 : 1;
}

/** Quote-path unrealized P&L. Shorts profit when market value falls below cost. */
export function signedQuoteUnrealizedPnl(
  absMarketValue: number,
  cost: number,
  totalPriceUnits: number,
): number {
  return (totalPriceUnits < 0 ? -1 : 1) * (absMarketValue - cost);
}

function resolvePositionCostMultiplier(
  position: TickerRecord["metadata"]["positions"][number],
): number {
  const priceMultiplier = normalizePositionMultiplier(position.multiplier);
  if (priceMultiplier === 1) return 1;

  if (position.marketValue == null || position.unrealizedPnl == null) {
    return priceMultiplier;
  }

  const costWithoutMultiplier = Math.abs(position.shares) * position.avgCost;
  const costWithMultiplier = costWithoutMultiplier * priceMultiplier;
  const withoutMultiplierError = Math.abs((position.marketValue - costWithoutMultiplier) - position.unrealizedPnl);
  const withMultiplierError = Math.abs((position.marketValue - costWithMultiplier) - position.unrealizedPnl);

  // Some broker derivative feeds report avgCost already scaled to the contract.
  return withoutMultiplierError < withMultiplierError ? 1 : priceMultiplier;
}

export function getPortfolioPositionMetrics(
  ticker: TickerRecord,
  activeTab: string | undefined,
  fallbackCurrency: string,
): PortfolioPositionMetrics {
  const tabPositions = activeTab
    ? ticker.metadata.positions.filter((position) => position.portfolio === activeTab)
    : ticker.metadata.positions;
  const positionCurrency = getPositionCurrency(tabPositions, fallbackCurrency);
  let totalShares = 0;
  let totalCost = 0;
  let totalCostUnits = 0;
  let totalPriceUnits = 0;
  let multiplierHint = 1;
  let brokerMktValue = 0;
  let hasBrokerMktValue = false;
  let brokerPnl = 0;
  let hasBrokerPnl = false;
  for (const position of tabPositions) {
    const direction = signedPositionDirection(position);
    const magnitude = Math.abs(position.shares);
    const priceMultiplier = normalizePositionMultiplier(position.multiplier);
    const costMultiplier = resolvePositionCostMultiplier(position);
    multiplierHint = Math.max(multiplierHint, priceMultiplier, costMultiplier);

    totalShares += magnitude * direction;
    totalCost += magnitude * position.avgCost * costMultiplier;
    totalCostUnits += magnitude * costMultiplier;
    totalPriceUnits += magnitude * priceMultiplier * direction;

    if (position.marketValue != null) {
      brokerMktValue += position.marketValue;
      hasBrokerMktValue = true;
    }
    if (position.unrealizedPnl != null) {
      brokerPnl += position.unrealizedPnl;
      hasBrokerPnl = true;
    }
  }

  return {
    positionCurrency,
    totalShares,
    totalCost,
    totalCostUnits,
    totalPriceUnits,
    multiplierHint,
    brokerMktValue,
    hasBrokerMktValue,
    brokerPnl,
    hasBrokerPnl,
    brokerMarkPrice: tabPositions.length === 1 ? tabPositions[0]?.markPrice : undefined,
  };
}

export function resolveBrokerFallbackMarketValue(metrics: PortfolioPositionMetrics): number | null {
  if (metrics.hasBrokerMktValue) return metrics.brokerMktValue;
  if (metrics.brokerMarkPrice != null && metrics.totalPriceUnits !== 0) {
    return Math.abs(metrics.totalPriceUnits) * metrics.brokerMarkPrice;
  }
  if (metrics.hasBrokerPnl) {
    return metrics.totalCost + metrics.brokerPnl;
  }
  return null;
}

export function resolveBrokerFallbackPnl(
  metrics: PortfolioPositionMetrics,
  brokerMarketValue: number | null,
): number | null {
  if (metrics.hasBrokerPnl) return metrics.brokerPnl;
  if (brokerMarketValue != null && metrics.totalCost !== 0) {
    return brokerMarketValue - metrics.totalCost;
  }
  return null;
}
