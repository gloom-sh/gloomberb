import { gdpVintageLabel, type RatioPoint, type RatioSeries } from "./align";
import { projectChart, type BuffettChartProjection } from "./chart-projection";
import {
  BUFFETT_MODES,
  RANGE_WINDOWS_MS,
  classifyZone,
  type BuffettModeId,
  type BuffettRangeId,
  type ZoneHit,
} from "./defs";
import { sigmaVsTrend, trendAt, type TrendFit } from "./trend";

const MS_PER_DAY = 86_400_000;

export interface Extreme {
  ratio: number;
  date: string;
}

export interface ModeBuild {
  series: RatioSeries;
  trend: TrendFit;
  cacheStale: boolean;
}

export interface BuffettBundle {
  modes: Partial<Record<BuffettModeId, ModeBuild>>;
  stale: boolean;
  errors: string[];
  fetchedAt: number;
}

export interface BuffettViewModel {
  requestedMode: BuffettModeId;
  displayedMode: BuffettModeId;
  range: BuffettRangeId;
  resolvedNumeratorId: string;
  current: RatioPoint;
  zone: ZoneHit;
  sigmaVsTrend: number;
  trendNow: number;
  gdpVintageDate: string;
  gdpVintageLabel: string;
  ratioOneYearAgo: number | null;
  allTimeHigh: Extreme;
  allTimeLow: Extreme;
  percentile: number;
  chart: BuffettChartProjection;
  asOf: string;
  observationStale: boolean;
  cacheStale: boolean;
  partial: boolean;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

export function sliceByRange(
  points: readonly RatioPoint[],
  range: BuffettRangeId,
  nowMs: number = Date.parse(points.at(-1)!.date),
): RatioPoint[] {
  const window = RANGE_WINDOWS_MS[range];
  if (window == null) return [...points];
  const cutoff = nowMs - window;
  const sliced = points.filter((p) => parseDateMs(p.date) >= cutoff);
  return sliced.length >= 2 ? sliced : [...points];
}

function findExtreme(
  points: readonly RatioPoint[],
  pick: "high" | "low",
): Extreme {
  let best = points[0]!;
  for (const p of points) {
    if (pick === "high" ? p.ratio > best.ratio : p.ratio < best.ratio) best = p;
  }
  return { ratio: best.ratio, date: best.date };
}

function ratioOneYearAgo(points: readonly RatioPoint[], currentDate: string): number | null {
  const cutoff = parseDateMs(currentDate) - 365 * MS_PER_DAY;
  let found: RatioPoint | null = null;
  for (const p of points) {
    if (parseDateMs(p.date) <= cutoff) found = p;
  }
  return found?.ratio ?? null;
}

export function projectView(
  build: ModeBuild,
  requestedMode: BuffettModeId,
  range: BuffettRangeId,
  opts: { partial: boolean; nowMs?: number },
): BuffettViewModel {
  const { series, trend, cacheStale } = build;
  const points = series.points;
  const current = points[points.length - 1]!;
  const nowMs = opts.nowMs ?? Date.now();
  const visible = sliceByRange(points, range);
  const zone = classifyZone(current.ratio);
  const mode = BUFFETT_MODES[series.mode];
  const observationAgeMs = nowMs - parseDateMs(current.date);
  const atOrBelow = points.filter((p) => p.ratio <= current.ratio).length;

  return {
    requestedMode,
    displayedMode: series.mode,
    range,
    resolvedNumeratorId: series.resolvedNumeratorId,
    current,
    zone,
    sigmaVsTrend: sigmaVsTrend(trend, current.ratio, current.date),
    trendNow: trendAt(trend, current.date),
    gdpVintageDate: series.gdpVintageDate,
    gdpVintageLabel: gdpVintageLabel(series.gdpVintageDate),
    ratioOneYearAgo: ratioOneYearAgo(points, current.date),
    allTimeHigh: findExtreme(points, "high"),
    allTimeLow: findExtreme(points, "low"),
    percentile: points.length === 0 ? 0 : (100 * atOrBelow) / points.length,
    chart: projectChart(visible),
    asOf: current.date,
    observationStale: observationAgeMs > mode.staleAfterMs,
    cacheStale,
    partial: opts.partial,
  };
}

export function selectBuffettView(
  bundle: BuffettBundle,
  requestedMode: BuffettModeId,
  range: BuffettRangeId,
): BuffettViewModel {
  const primary = bundle.modes[requestedMode];
  const fallbackId: BuffettModeId = requestedMode === "wilshire" ? "z1" : "wilshire";
  const chosen = primary ?? bundle.modes[fallbackId];
  if (!chosen) throw new Error("Buffett Indicator unavailable");
  return projectView(chosen, requestedMode, range, {
    partial: Object.keys(bundle.modes).length === 1,
  });
}
