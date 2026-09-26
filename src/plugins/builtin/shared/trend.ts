const MS_PER_DAY = 86_400_000;

/**
 * A log fit suits a level that compounds. A measure that can sit at or below
 * zero, like an excess yield or most economic statistics, needs the linear one,
 * since taking logs would silently drop exactly its most extreme readings.
 */
export type TrendModel = "log" | "linear";

export interface TrendPoint {
  date: string;
  value: number | null;
}

export interface TrendFit {
  model: TrendModel;
  alpha: number;
  beta: number;
  sigma: number;
  originMs: number;
}

/** Least-squares fit of value against time. */
export function fitTrend(points: readonly TrendPoint[], model: TrendModel): TrendFit {
  const usable = points.filter((point): point is { date: string; value: number } =>
    point.value != null && Number.isFinite(point.value) && (model !== "log" || point.value > 0));
  const empty: TrendFit = { model, alpha: 0, beta: 0, sigma: 0, originMs: 0 };
  if (usable.length === 0) return empty;

  const originMs = Date.parse(usable[0]!.date);
  const project = (value: number) => (model === "log" ? Math.log(value) : value);
  if (usable.length < 2) {
    return { model, alpha: project(usable[0]!.value), beta: 0, sigma: 0, originMs };
  }

  const xs = usable.map((point) => (Date.parse(point.date) - originMs) / MS_PER_DAY);
  const ys = usable.map((point) => project(point.value));
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

export function trendAt(fit: TrendFit, date: string): number {
  const fitted = fit.alpha + fit.beta * ((Date.parse(date) - fit.originMs) / MS_PER_DAY);
  return fit.model === "log" ? Math.exp(fitted) : fitted;
}

/** Distance from the trend in residual standard deviations; zero when the fit cannot place it. */
export function sigmaVsTrend(fit: TrendFit, value: number, date: string): number {
  if (!(fit.sigma > 0)) return 0;
  if (fit.model === "linear") return (value - trendAt(fit, date)) / fit.sigma;
  if (!(value > 0)) return 0;
  return (Math.log(value) - Math.log(trendAt(fit, date))) / fit.sigma;
}
