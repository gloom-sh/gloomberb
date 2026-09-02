import type { RatioPoint } from "./align";
import type { IndicatorDef } from "./defs";

const MS_PER_DAY = 86_400_000;

export interface TrendFit {
  model: "log" | "linear";
  alpha: number;
  beta: number;
  sigma: number;
  originMs: number;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

/**
 * Least-squares fit of value against time. A log fit suits a level that compounds;
 * a measure that can sit at or below zero, like an excess yield, needs the linear
 * one, since taking logs would silently drop exactly its most extreme years.
 */
export function fitTrend(
  points: readonly RatioPoint[],
  model: "log" | "linear" = "log",
): TrendFit {
  const usable = model === "log"
    ? points.filter((p) => p.ratio > 0 && Number.isFinite(p.ratio))
    : points.filter((p) => Number.isFinite(p.ratio));
  const empty: TrendFit = { model, alpha: 0, beta: 0, sigma: 0, originMs: 0 };
  if (usable.length === 0) return empty;

  const originMs = parseDateMs(usable[0]!.date);
  const project = (value: number) => (model === "log" ? Math.log(value) : value);
  if (usable.length < 2) {
    return { model, alpha: project(usable[0]!.ratio), beta: 0, sigma: 0, originMs };
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of usable) {
    xs.push((parseDateMs(point.date) - originMs) / MS_PER_DAY);
    ys.push(project(point.ratio));
  }
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i]!;
    sumY += ys[i]!;
    sumXX += xs[i]! * xs[i]!;
    sumXY += xs[i]! * ys[i]!;
  }
  const denom = n * sumXX - sumX * sumX;
  const beta = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const alpha = (sumY - beta * sumX) / n;
  if (n < 3) return { model, alpha, beta, sigma: 0, originMs };

  let residualSq = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = ys[i]! - (alpha + beta * xs[i]!);
    residualSq += residual * residual;
  }
  return { model, alpha, beta, sigma: Math.sqrt(residualSq / (n - 2)), originMs };
}

export function fitIndicatorTrend(
  indicator: IndicatorDef,
  points: readonly RatioPoint[],
): TrendFit {
  return fitTrend(points, indicator.trendModel);
}

export function trendAt(fit: TrendFit, date: string): number {
  const tDays = (parseDateMs(date) - fit.originMs) / MS_PER_DAY;
  const fitted = fit.alpha + fit.beta * tDays;
  return fit.model === "log" ? Math.exp(fitted) : fitted;
}

export function sigmaVsTrend(fit: TrendFit, value: number, date: string): number {
  if (!(fit.sigma > 0)) return 0;
  if (fit.model === "linear") {
    return (value - trendAt(fit, date)) / fit.sigma;
  }
  if (!(value > 0)) return 0;
  return (Math.log(value) - Math.log(trendAt(fit, date))) / fit.sigma;
}
