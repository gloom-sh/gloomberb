import { colors, type ThemeColors } from "../../theme/colors";
import { appendLiveQuotePoint } from "../../time-series/chart-data";
import type { PricePoint, Quote } from "../../types/financials";
import { getPricePointTimestamp } from "../../utils/price-history";

const SPARKLINE_FALLBACK_POINTS = 22;
/** Vertical steps a one-row sparkline can show; a smaller live move redraws nothing. */
const LIVE_POINT_STEPS = 64;

export type PriceSparklineTrend = "positive" | "negative" | "neutral";
export type PriceSparklinePeriod = "1D" | "1W" | "1M" | "1Y";

export interface SparklineSample {
  x: number;
  y: number;
}

const PERIOD_WINDOW_DAYS: Record<PriceSparklinePeriod, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "1Y": 365,
};

const PERIOD_FALLBACK_POINTS: Record<PriceSparklinePeriod, number> = {
  "1D": 2,
  "1W": 7,
  "1M": SPARKLINE_FALLBACK_POINTS,
  "1Y": 252,
};

function closeValue(point: PricePoint): number | null {
  return Number.isFinite(point.close) ? point.close : null;
}

export function resolveSparklineHistory(priceHistory: PricePoint[], period: PriceSparklinePeriod = "1M"): PricePoint[] {
  const validHistory = priceHistory.filter((point) => Number.isFinite(getPricePointTimestamp(point)));
  const latest = validHistory.at(-1);
  if (!latest) return [];

  const latestTime = getPricePointTimestamp(latest);
  if (Number.isFinite(latestTime)) {
    const cutoffTime = latestTime - PERIOD_WINDOW_DAYS[period] * 86_400_000;
    const windowHistory = validHistory.filter((point) => getPricePointTimestamp(point) >= cutoffTime);
    if (windowHistory.length >= 2) return windowHistory;
  }

  return validHistory.slice(-PERIOD_FALLBACK_POINTS[period]);
}

export function sparklineValues(priceHistory: PricePoint[]): number[] {
  return priceHistory
    .map(closeValue)
    .filter((value): value is number => value != null);
}

export function sparklineColor(
  values: number[],
  trend?: PriceSparklineTrend,
  palette: ThemeColors = colors,
): string {
  if (trend === "positive") return palette.positive;
  if (trend === "negative") return palette.negative;
  if (trend === "neutral") return palette.textMuted;

  const first = values[0];
  const last = values.at(-1);
  if (first == null || last == null) return palette.textMuted;
  return last >= first ? palette.positive : palette.negative;
}

export function buildSamples(values: number[], width: number, height: number, padding: number): SparklineSample[] {
  if (values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const left = padding;
  const right = Math.max(left, width - padding);
  const top = padding;
  const bottom = Math.max(top, height - padding);
  return values.map((value, index) => ({
    x: left + (index / Math.max(values.length - 1, 1)) * (right - left),
    y: bottom - ((value - min) / range) * (bottom - top),
  }));
}

export function svgPath(samples: SparklineSample[]): string {
  return samples
    .map((sample, index) => `${index === 0 ? "M" : "L"}${sample.x.toFixed(2)} ${sample.y.toFixed(2)}`)
    .join(" ");
}

export function svgAreaPath(samples: SparklineSample[], baseline: number): string {
  const linePath = svgPath(samples);
  if (!linePath || samples.length === 0) return "";
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return `${linePath} L${last.x.toFixed(2)} ${baseline.toFixed(2)} L${first.x.toFixed(2)} ${baseline.toFixed(2)} Z`;
}

export function colorWithAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const normalized = color.replace("#", "");
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function resolvePriceSparklineRange(
  priceHistory: PricePoint[] | undefined,
  period: PriceSparklinePeriod = "1M",
): { min: number; max: number } | null {
  const values = sparklineValues(resolveSparklineHistory(priceHistory ?? [], period));
  if (values.length < 2) return null;
  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Completed bars end at the last fetch; during a session the live price closes
 * the line. Pass the series returned for the previous quote on the same bars:
 * a move too small to show keeps that series, so a tick does not redraw it.
 */
export function followLiveSparklinePrice(
  priceHistory: PricePoint[],
  quote: Quote | null | undefined,
  options: { assetCategory?: string; period?: PriceSparklinePeriod; previous?: PricePoint[]; now?: number } = {},
): PricePoint[] {
  const next = appendLiveQuotePoint(priceHistory, quote, { assetCategory: options.assetCategory, now: options.now });
  const previous = options.previous;
  if (!previous || next === priceHistory || previous === priceHistory || previous.length !== next.length) return next;
  const shown = sparklineValues(resolveSparklineHistory(next, options.period));
  const prior = previous.at(-1)?.close;
  const latest = shown.at(-1);
  if (shown.length < 3 || prior == null || latest == null || !Number.isFinite(prior)) return next;
  const bars = shown.slice(0, -1);
  const min = Math.min(...bars);
  const max = Math.max(...bars);
  const inside = (value: number) => value >= min && value <= max;
  // The line's colour compares the last point with the first.
  const sameTrend = (latest >= shown[0]!) === (prior >= shown[0]!);
  return sameTrend && inside(prior) && inside(latest) && Math.abs(latest - prior) * LIVE_POINT_STEPS <= max - min
    ? previous : next;
}
