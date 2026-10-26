import type { PricePoint } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { isDepositaryReceiptCategory, normalizeAssetCategory } from "../../../utils/asset-category";
import { getPricePointTimestamp } from "../../../utils/price-history";
import { mergePriceHistoryIntegrity, pricePointIntegrity, type PriceHistoryIntegrity } from "../../../utils/price-history-integrity";

export interface DatedReturn {
  startDateKey: string;
  dateKey: string;
  value: number;
}

export interface WeightedReturnSeries {
  weight: number;
  returns: DatedReturn[];
}

/** The synthetic daily-equity basket cannot model financing or leveraged exposure. */
export function syntheticAccountUnsupportedReason(account?: BrokerAccount | null): string | null {
  if (!account) return null;
  if ((Number.isFinite(account.totalCashValue) && account.totalCashValue! < 0)
    || (Number.isFinite(account.netLiquidation) && (account.netLiquidation! <= 0
      || (Number.isFinite(account.grossPositionValue) && account.grossPositionValue! > account.netLiquidation!)))) {
    return "Leveraged account: financing history required";
  }
  return null;
}

/** Normalised categories the equity basket takes besides depositary receipts; no category at all counts as an equity. */
const EQUITY_CATEGORIES: ReadonlySet<string> = new Set(["", "STK", "STOCK", "COMMONSTOCK", "EQUITY", "ETF", "ETN", "FUND", "REIT"]);

export function syntheticPositionUnsupportedReason(ticker: TickerRecord, quoteCurrency: string, portfolioId?: string): string | null {
  const positions = ticker.metadata.positions.filter((position) => (
    (!portfolioId || position.portfolio === portfolioId) && position.shares !== 0
  ));
  if (positions.some((position) => position.side === "short" || position.shares < 0)) {
    return "Short positions: signed exposure history required";
  }
  const category = normalizeAssetCategory(ticker.metadata.assetCategory);
  // Crypto trades every day at another close, so its daily returns do not pair with the equity factor proxies.
  if (category.startsWith("CRYPTO") || /-[A-Z]{3,4}$/.test(ticker.metadata.ticker)) {
    return "Crypto is not covered by the equity basket";
  }
  // "Common Stock" is the category provider search hands a ticker added from
  // the command bar, so a plain equity must not read as unsupported; a
  // depositary receipt is the equity of its home market, whatever it is called.
  if (!(EQUITY_CATEGORIES.has(category) || isDepositaryReceiptCategory(category))
    || positions.some((position) => position.multiplier != null && position.multiplier !== 1)
    || /=[A-Z]+$|\d{6}[CP]\d{8}$/.test(ticker.metadata.ticker)) {
    return "Asset type is not covered by the equity basket";
  }
  if (quoteCurrency !== "USD") return "Foreign holdings: historical FX returns required";
  return null;
}

function toDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
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

export interface ReturnHistoryResult {
  returns: DatedReturn[];
  integrity: PriceHistoryIntegrity | null;
}

export function resolveDatedReturns(history: PricePoint[]): ReturnHistoryResult {
  const byTimestamp = new Map<number, PricePoint>();
  for (const point of history) {
    const timestamp = getPricePointTimestamp(point);
    if (Number.isFinite(timestamp)) byTimestamp.set(timestamp, point);
  }
  const reported = [...byTimestamp].map(([timestamp, point]) => ({ timestamp, point }));
  const issues = reported.map(({ point }) => pricePointIntegrity(point))
    .filter((entry): entry is PriceHistoryIntegrity => !!entry);
  // Dropping the rejected day would silently change the risk sample and bridge
  // its neighbors. Quarantine the sample until corrected source data arrives.
  if (issues.length > 0) return { returns: [], integrity: mergePriceHistoryIntegrity(...issues) };
  const points = reported.sort((left, right) => left.timestamp - right.timestamp);

  const returns: DatedReturn[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    if (!Number.isFinite(previous.point.close) || previous.point.close <= 0
      || !Number.isFinite(current.point.close) || current.point.close <= 0) continue;
    const startDateKey = toDateKey(previous.timestamp);
    const dateKey = toDateKey(current.timestamp);
    if (startDateKey === dateKey) continue;
    const value = (current.point.close - previous.point.close) / previous.point.close;
    if (!Number.isFinite(value)) continue;
    returns.push({
      startDateKey,
      dateKey,
      value,
    });
  }
  return { returns, integrity: null };
}

function validReturnInterval(point: DatedReturn): boolean {
  return typeof point.startDateKey === "string" && point.startDateKey < point.dateKey && Number.isFinite(point.value);
}

function returnIntervalKey(point: DatedReturn): string {
  return `${point.startDateKey}/${point.dateKey}`;
}

/** The intervals every series covers, and each series' return on them, in the first series' order. */
interface AlignedSeries {
  series: DatedReturn[][];
  lengths: number[];
  points: DatedReturn[];
  values: Float64Array[];
}

/**
 * Lined-up holdings, kept with their series: weights move with every quote,
 * the series only with their bars, so a portfolio valued again (each Cloud
 * sync values every one) only weighs returns already lined up
 * instead of matching every interval of every holding again. A few lists per
 * first series, since one holding can open more than one portfolio.
 */
const alignedByFirstSeries = new WeakMap<DatedReturn[], AlignedSeries[]>();

function alignSeries(series: DatedReturn[][]): AlignedSeries {
  const kept = alignedByFirstSeries.get(series[0]!) ?? [];
  const cached = kept.find((entry) => entry.series.length === series.length
    && entry.series.every((returns, index) => returns === series[index] && entry.lengths[index] === returns.length));
  if (cached) return cached;
  const samples = series.map((returns) => new Map(returns
    .filter(validReturnInterval)
    .map((point) => [returnIntervalKey(point), point])));
  const points: DatedReturn[] = [];
  const columns: number[][] = series.map(() => []);
  for (const [key, first] of samples[0]!) {
    const row: number[] = [];
    for (const sample of samples) {
      const point = sample.get(key);
      if (!point) break;
      row.push(point.value);
    }
    if (row.length < samples.length) continue;
    points.push(first);
    row.forEach((value, index) => columns[index]!.push(value));
  }
  const aligned = { series: [...series], lengths: series.map((returns) => returns.length), points, values: columns.map((column) => Float64Array.from(column)) };
  alignedByFirstSeries.set(series[0]!, [aligned, ...kept].slice(0, 4));
  return aligned;
}

export function computeWeightedPortfolioReturns(series: WeightedReturnSeries[]): DatedReturn[] {
  const holdings = series.filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0);
  const totalWeight = holdings.reduce((sum, entry) => sum + entry.weight, 0);
  if (!holdings.length || !Number.isFinite(totalWeight) || totalWeight <= 0) return [];
  const { points, values } = alignSeries(holdings.map((entry) => entry.returns));
  const returns: DatedReturn[] = [];
  for (let row = 0; row < points.length; row++) {
    let value = 0;
    for (let index = 0; index < holdings.length; index++) {
      value += values[index]![row]! * (holdings[index]!.weight / totalWeight);
    }
    if (Number.isFinite(value)) returns.push({ ...points[row]!, value });
  }
  return returns.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

export function alignedAssetReturns(assetReturns: DatedReturn[], marketReturns: DatedReturn[]): DatedReturn[] {
  const marketIntervals = new Set(marketReturns.filter(validReturnInterval).map(returnIntervalKey));
  return assetReturns.filter((point) => validReturnInterval(point) && marketIntervals.has(returnIntervalKey(point)));
}

function alignReturnSeries(assetReturns: DatedReturn[], marketReturns: DatedReturn[]): { asset: number[]; market: number[] } {
  const marketByInterval = new Map(marketReturns.filter(validReturnInterval).map((point) => [returnIntervalKey(point), point.value]));
  const aligned = alignedAssetReturns(assetReturns, marketReturns);
  return { asset: aligned.map((point) => point.value), market: aligned.map((point) => marketByInterval.get(returnIntervalKey(point))!) };
}

export function computeDatedBeta(assetReturns: DatedReturn[], marketReturns: DatedReturn[]): number | null {
  const aligned = alignReturnSeries(assetReturns, marketReturns);
  return computeBeta(aligned.asset, aligned.market);
}

export function hasPortfolioPosition(ticker: TickerRecord, portfolioId: string): boolean {
  return ticker.metadata.positions.some((position) => position.portfolio === portfolioId);
}
