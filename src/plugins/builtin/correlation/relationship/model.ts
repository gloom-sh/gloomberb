import type { ProjectedChartPoint } from "../../../../components/chart/core/data";
import type { TimeRange } from "../../../../components/chart/core/types";
import type { ScatterChartPoint } from "../../../../components/chart/static";
import type { PaneSettingsDef, PaneTemplateCreateOptions } from "../../../../types/plugin";
import type { PricePoint } from "../../../../types/financials";
import { formatTickerListInput, parseTickerListInput } from "../../../../tickers/list";

export type RelationshipRange = Extract<TimeRange, "1M" | "3M" | "6M" | "1Y" | "5Y" | "ALL">;

export const RELATIONSHIP_GRAPH_PANE_ID = "relationship-graph";
const RELATIONSHIP_RANGES: RelationshipRange[] = ["1M", "3M", "6M", "1Y", "5Y", "ALL"];
export const DEFAULT_RELATIONSHIP_SECOND_SYMBOL = "SPY";
const RELATIONSHIP_CORRELATION_WINDOWS = [30, 60, 120, 252] as const;
export const DEFAULT_RELATIONSHIP_CORRELATION_WINDOW = 120;

export interface RelationshipAlignedPoint {
  date: Date;
  dateKey: string;
  leftClose: number;
  rightClose: number;
  ratio: number;
}

export interface RelationshipReturnPoint {
  date: Date;
  dateKey: string;
  leftReturn: number;
  rightReturn: number;
}

export interface RelationshipRegressionStats {
  beta: number;
  alpha: number;
  r: number;
  rSquared: number;
  stdError: number | null;
  sampleSize: number;
}

export interface RelationshipAnalysis {
  aligned: RelationshipAlignedPoint[];
  returns: RelationshipReturnPoint[];
  ratioPoints: ProjectedChartPoint[];
  correlationPoints: ProjectedChartPoint[];
  scatterPoints: ScatterChartPoint[];
  stats: RelationshipRegressionStats | null;
  latestRatio: number | null;
  latestCorrelation: number | null;
}

function pricePointTime(point: PricePoint): number {
  const value = point.date as Date | string | number;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function pricePointDateKey(point: PricePoint): string | null {
  const timestamp = pricePointTime(point);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function syntheticChartPoint(date: Date, value: number): ProjectedChartPoint {
  return {
    date,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: 0,
  };
}

function alignRelationshipPrices(leftPoints: PricePoint[], rightPoints: PricePoint[]): RelationshipAlignedPoint[] {
  const rightByDate = new Map<string, PricePoint>();
  for (const point of rightPoints) {
    const dateKey = pricePointDateKey(point);
    if (!dateKey || !Number.isFinite(point.close) || point.close <= 0) continue;
    rightByDate.set(dateKey, point);
  }

  return [...leftPoints]
    .sort((left, right) => pricePointTime(left) - pricePointTime(right))
    .flatMap((leftPoint): RelationshipAlignedPoint[] => {
      const dateKey = pricePointDateKey(leftPoint);
      if (!dateKey || !Number.isFinite(leftPoint.close) || leftPoint.close <= 0) return [];
      const rightPoint = rightByDate.get(dateKey);
      if (!rightPoint || !Number.isFinite(rightPoint.close) || rightPoint.close <= 0) return [];
      const timestamp = pricePointTime(leftPoint);
      return [{
        date: new Date(timestamp),
        dateKey,
        leftClose: leftPoint.close,
        rightClose: rightPoint.close,
        ratio: leftPoint.close / rightPoint.close,
      }];
    });
}

function buildRelationshipReturns(aligned: RelationshipAlignedPoint[]): RelationshipReturnPoint[] {
  const returns: RelationshipReturnPoint[] = [];
  for (let index = 1; index < aligned.length; index++) {
    const previous = aligned[index - 1]!;
    const current = aligned[index]!;
    if (previous.leftClose <= 0 || previous.rightClose <= 0) continue;
    const leftReturn = (current.leftClose - previous.leftClose) / previous.leftClose;
    const rightReturn = (current.rightClose - previous.rightClose) / previous.rightClose;
    if (!Number.isFinite(leftReturn) || !Number.isFinite(rightReturn)) continue;
    returns.push({
      date: current.date,
      dateKey: current.dateKey,
      leftReturn,
      rightReturn,
    });
  }
  return returns;
}

function pearson(x: number[], y: number[], minObservations = 5): number | null {
  const n = Math.min(x.length, y.length);
  if (n < minObservations) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const xValue = x[i]!;
    const yValue = y[i]!;
    sumX += xValue;
    sumY += yValue;
    sumXY += xValue * yValue;
    sumX2 += xValue * xValue;
    sumY2 += yValue * yValue;
  }

  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denominator === 0 ? null : (n * sumXY - sumX * sumY) / denominator;
}

function buildRollingCorrelationPoints(
  returns: RelationshipReturnPoint[],
  windowSize: number,
): ProjectedChartPoint[] {
  const points: ProjectedChartPoint[] = [];
  for (let index = 0; index < returns.length; index++) {
    const window = returns.slice(Math.max(0, index - windowSize + 1), index + 1);
    const correlation = pearson(
      window.map((entry) => entry.rightReturn),
      window.map((entry) => entry.leftReturn),
      5,
    );
    if (correlation === null) continue;
    points.push(syntheticChartPoint(returns[index]!.date, correlation));
  }
  return points;
}

function computeRelationshipRegression(returns: RelationshipReturnPoint[]): RelationshipRegressionStats | null {
  const x = returns.map((entry) => entry.rightReturn * 100);
  const y = returns.map((entry) => entry.leftReturn * 100);
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;

  const meanX = x.reduce((sum, value) => sum + value, 0) / n;
  const meanY = y.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index++) {
    const dx = x[index]! - meanX;
    numerator += dx * (y[index]! - meanY);
    denominator += dx * dx;
  }
  if (denominator === 0) return null;

  const beta = numerator / denominator;
  const alpha = meanY - beta * meanX;
  const r = pearson(x, y, 5);
  if (r === null) return null;

  let residualSumSquares = 0;
  for (let index = 0; index < n; index++) {
    const fitted = alpha + beta * x[index]!;
    const residual = y[index]! - fitted;
    residualSumSquares += residual * residual;
  }

  return {
    beta,
    alpha,
    r,
    rSquared: r * r,
    stdError: n > 2 ? Math.sqrt(residualSumSquares / (n - 2)) : null,
    sampleSize: n,
  };
}

export function buildRelationshipAnalysis(
  leftPoints: PricePoint[],
  rightPoints: PricePoint[],
  correlationWindow = DEFAULT_RELATIONSHIP_CORRELATION_WINDOW,
): RelationshipAnalysis {
  const aligned = alignRelationshipPrices(leftPoints, rightPoints);
  const returns = buildRelationshipReturns(aligned);
  const correlationPoints = buildRollingCorrelationPoints(returns, correlationWindow);
  const scatterPoints = returns.map((entry, index) => ({
    x: entry.rightReturn * 100,
    y: entry.leftReturn * 100,
    highlight: index === returns.length - 1,
  }));
  const stats = computeRelationshipRegression(returns);

  return {
    aligned,
    returns,
    ratioPoints: aligned.map((entry) => syntheticChartPoint(entry.date, entry.ratio)),
    correlationPoints,
    scatterPoints,
    stats,
    latestRatio: aligned.at(-1)?.ratio ?? null,
    latestCorrelation: correlationPoints.at(-1)?.close ?? null,
  };
}

function normalizeRelationshipSymbols(symbols: string[]): [string, string] | null {
  const normalized = symbols
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  if (normalized.length === 0) return null;
  return [
    normalized[0]!,
    normalized[1] ?? DEFAULT_RELATIONSHIP_SECOND_SYMBOL,
  ];
}

export function relationshipSymbolsFromPaneSettings(
  settings: Record<string, unknown> | undefined,
  fallbackSymbol: string | null,
): [string, string] | null {
  const symbols = settings?.symbols;
  if (Array.isArray(symbols)) {
    const pair = normalizeRelationshipSymbols(symbols.filter((symbol): symbol is string => typeof symbol === "string"));
    if (pair) return pair;
  }

  const symbolsText = settings?.symbolsText;
  if (typeof symbolsText === "string" && symbolsText.trim()) {
    try {
      return normalizeRelationshipSymbols(parseTickerListInput(symbolsText));
    } catch {
      return fallbackSymbol ? [fallbackSymbol, DEFAULT_RELATIONSHIP_SECOND_SYMBOL] : null;
    }
  }

  return fallbackSymbol ? [fallbackSymbol, DEFAULT_RELATIONSHIP_SECOND_SYMBOL] : null;
}

export function nextRelationshipRange(current: RelationshipRange): RelationshipRange {
  const index = RELATIONSHIP_RANGES.indexOf(current);
  return RELATIONSHIP_RANGES[(index + 1) % RELATIONSHIP_RANGES.length] ?? "1Y";
}

export function nextRelationshipWindow(current: number): number {
  const index = RELATIONSHIP_CORRELATION_WINDOWS.findIndex((value) => value === current);
  return RELATIONSHIP_CORRELATION_WINDOWS[(index + 1) % RELATIONSHIP_CORRELATION_WINDOWS.length]
    ?? DEFAULT_RELATIONSHIP_CORRELATION_WINDOW;
}

export function relationshipTemplateSymbols(
  activeTicker: string | null,
  options: Pick<PaneTemplateCreateOptions, "arg" | "values" | "symbols"> | undefined,
): [string, string] | null {
  if (options?.symbols?.length) return normalizeRelationshipSymbols(options.symbols);
  const raw = options?.arg ?? options?.values?.tickers ?? activeTicker ?? "";
  try {
    return normalizeRelationshipSymbols(parseTickerListInput(raw));
  } catch {
    return null;
  }
}

export function buildRelationshipGraphPaneTitle(pair: readonly [string, string]): string {
  return `GR ${pair[0]}/${pair[1]}`;
}

export function buildRelationshipGraphSettingsDef(): PaneSettingsDef {
  return {
    title: "Relationship Graph Settings",
    fields: [
      {
        key: "symbolsText",
        label: "Tickers",
        description: `Enter one or two tickers. One ticker compares against ${DEFAULT_RELATIONSHIP_SECOND_SYMBOL}.`,
        type: "text",
        placeholder: formatTickerListInput(["AMD", "NVDA"]),
      },
    ],
  };
}
