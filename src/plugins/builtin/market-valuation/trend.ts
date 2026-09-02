import type { RatioPoint } from "./align";

const MS_PER_DAY = 86_400_000;

export interface TrendFit {
  alpha: number;
  beta: number;
  sigma: number;
  originMs: number;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

export function fitLogLinearTrend(points: readonly RatioPoint[]): TrendFit {
  const usable = points.filter((p) => p.ratio > 0 && Number.isFinite(p.ratio));
  if (usable.length === 0) {
    return { alpha: 0, beta: 0, sigma: 0, originMs: 0 };
  }
  const originMs = parseDateMs(usable[0]!.date);
  if (usable.length < 2) {
    return {
      alpha: Math.log(usable[0]!.ratio),
      beta: 0,
      sigma: 0,
      originMs,
    };
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of usable) {
    xs.push((parseDateMs(p.date) - originMs) / MS_PER_DAY);
    ys.push(Math.log(p.ratio));
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

  if (n < 3) {
    return { alpha, beta, sigma: 0, originMs };
  }

  let residualSq = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = ys[i]! - (alpha + beta * xs[i]!);
    residualSq += residual * residual;
  }
  const sigma = Math.sqrt(residualSq / (n - 2));
  return { alpha, beta, sigma, originMs };
}

export function trendAt(fit: TrendFit, date: string): number {
  const tDays = (parseDateMs(date) - fit.originMs) / MS_PER_DAY;
  return Math.exp(fit.alpha + fit.beta * tDays);
}

export function sigmaVsTrend(fit: TrendFit, ratio: number, date: string): number {
  if (!(fit.sigma > 0) || !(ratio > 0)) return 0;
  return (Math.log(ratio) - Math.log(trendAt(fit, date))) / fit.sigma;
}
