import type { StatPoint } from "./transform";

const MS_PER_DAY = 86_400_000;

export interface TrendFit {
  alpha: number;
  beta: number;
  sigma: number;
  originMs: number;
}

/**
 * Plain least squares against time. These series go negative routinely, so unlike
 * the valuation ratios there is no log variant to choose.
 */
export function fitTrend(points: readonly StatPoint[]): TrendFit {
  const usable = points.filter((point) => Number.isFinite(point.value));
  const empty: TrendFit = { alpha: 0, beta: 0, sigma: 0, originMs: 0 };
  if (usable.length === 0) return empty;

  const originMs = Date.parse(usable[0]!.date);
  if (usable.length < 2) return { alpha: usable[0]!.value, beta: 0, sigma: 0, originMs };

  const xs = usable.map((point) => (Date.parse(point.date) - originMs) / MS_PER_DAY);
  const ys = usable.map((point) => point.value);
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
  if (n < 3) return { alpha, beta, sigma: 0, originMs };

  let residualSq = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = ys[i]! - (alpha + beta * xs[i]!);
    residualSq += residual * residual;
  }
  return { alpha, beta, sigma: Math.sqrt(residualSq / (n - 2)), originMs };
}

export function trendAt(fit: TrendFit, date: string): number {
  return fit.alpha + fit.beta * ((Date.parse(date) - fit.originMs) / MS_PER_DAY);
}

export function sigmaVsTrend(fit: TrendFit, value: number, date: string): number {
  if (!(fit.sigma > 0)) return 0;
  return (value - trendAt(fit, date)) / fit.sigma;
}
