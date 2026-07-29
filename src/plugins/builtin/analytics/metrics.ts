import type { PricePoint } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { getPricePointTimestamp } from "../../../utils/price-history";

export interface DatedReturn {
  dateKey: string;
  value: number;
}

export interface WeightedReturnSeries {
  weight: number;
  returns: DatedReturn[];
}

function toDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function computeSharpeRatio(returns: number[], riskFreeRate = 0.05): number | null {
  if (returns.length < 10) return null;
  const n = returns.length;
  const meanReturn = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  if (variance < Number.EPSILON) return null;
  const annualizedReturn = meanReturn * 252;
  const annualizedStdDev = stdDev * Math.sqrt(252);
  return (annualizedReturn - riskFreeRate) / annualizedStdDev;
}

export function computeBeta(assetReturns: number[], marketReturns: number[]): number | null {
  const n = Math.min(assetReturns.length, marketReturns.length);
  if (n < 10) return null;
  let sumMarket = 0, sumAsset = 0;
  for (let i = 0; i < n; i++) {
    sumMarket += marketReturns[i]!;
    sumAsset += assetReturns[i]!;
  }
  const meanMarket = sumMarket / n;
  const meanAsset = sumAsset / n;
  let covariance = 0, marketVariance = 0;
  for (let i = 0; i < n; i++) {
    const dm = marketReturns[i]! - meanMarket;
    const da = assetReturns[i]! - meanAsset;
    covariance += dm * da;
    marketVariance += dm * dm;
  }
  if (marketVariance === 0) return null;
  return covariance / marketVariance;
}

export function computeDatedReturns(history: PricePoint[]): DatedReturn[] {
  const points = history
    .map((point) => ({ point, timestamp: getPricePointTimestamp(point) }))
    .filter(({ point, timestamp }) => (
      Number.isFinite(timestamp)
      && Number.isFinite(point.close)
      && point.close > 0
    ))
    .sort((left, right) => left.timestamp - right.timestamp);

  const returns: DatedReturn[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    const value = (current.point.close - previous.point.close) / previous.point.close;
    if (!Number.isFinite(value)) continue;
    returns.push({
      dateKey: toDateKey(current.timestamp),
      value,
    });
  }
  return returns;
}

export function computeWeightedPortfolioReturns(series: WeightedReturnSeries[]): DatedReturn[] {
  const totals = new Map<string, { weightedReturn: number; weight: number }>();

  for (const entry of series) {
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) continue;
    for (const point of entry.returns) {
      if (!Number.isFinite(point.value)) continue;
      const current = totals.get(point.dateKey) ?? { weightedReturn: 0, weight: 0 };
      current.weightedReturn += point.value * entry.weight;
      current.weight += entry.weight;
      totals.set(point.dateKey, current);
    }
  }

  return [...totals.entries()]
    .filter(([, total]) => total.weight > 0)
    .map(([dateKey, total]) => ({
      dateKey,
      value: total.weightedReturn / total.weight,
    }))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

function alignReturnSeries(
  assetReturns: DatedReturn[],
  marketReturns: DatedReturn[],
): { asset: number[]; market: number[] } {
  const marketByDate = new Map(marketReturns.map((point) => [point.dateKey, point.value]));
  const asset: number[] = [];
  const market: number[] = [];

  for (const point of assetReturns) {
    const marketValue = marketByDate.get(point.dateKey);
    if (marketValue == null) continue;
    asset.push(point.value);
    market.push(marketValue);
  }

  return { asset, market };
}

export function computeDatedBeta(assetReturns: DatedReturn[], marketReturns: DatedReturn[]): number | null {
  const aligned = alignReturnSeries(assetReturns, marketReturns);
  return computeBeta(aligned.asset, aligned.market);
}

export interface SectorAllocation {
  sector: string;
  weight: number;
  value: number;
}

export function computeSectorAllocation(
  positions: Array<{ sector: string; marketValue: number }>,
): SectorAllocation[] {
  const sectorMap = new Map<string, number>();
  let total = 0;
  for (const pos of positions) {
    const sector = pos.sector || "Unknown";
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + pos.marketValue);
    total += pos.marketValue;
  }
  if (total === 0) return [];
  return [...sectorMap.entries()]
    .map(([sector, value]) => ({ sector, weight: value / total, value }))
    .sort((a, b) => b.weight - a.weight || a.sector.localeCompare(b.sector));
}

export function hasPortfolioPosition(ticker: TickerRecord, portfolioId: string): boolean {
  return ticker.metadata.positions.some((position) => position.portfolio === portfolioId);
}
