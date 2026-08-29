import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { ChartIndicatorOverlays } from "../../../components/chart/core/types";
import type { FredSeriesData, FredSeriesRequest } from "../../../data/fred-series";
import { blendHex, colors } from "../../../theme/colors";

export type BuffettModeId = "wilshire" | "z1";
export type BuffettRangeId = "10Y" | "25Y" | "ALL";
export type AlignmentRuleId = "interpolate-gdp" | "same-quarter";

export interface SeriesDef {
  seriesId: string;
  /** Multiply raw FRED values to $ billions. Z.1 is 1/1000; others 1. */
  scaleToBillions: number;
  request: Pick<FredSeriesRequest, "limit" | "sortOrder">;
  /** Tried only if the primary seriesId fails to produce observations. */
  fallbackSeriesId?: string;
}

export interface ModeDef {
  id: BuffettModeId;
  label: string;
  numerator: SeriesDef;
  denominator: SeriesDef;
  align: AlignmentRuleId;
  /** Observation cadence including publication lag. Footer STALE uses this. */
  staleAfterMs: number;
}

export interface ScaledObs {
  date: string;
  value: number;
}

export interface RatioPoint {
  date: string;
  ratio: number;
  marketCapBillions: number;
  gdpBillions: number;
}

export interface RatioSeries {
  mode: BuffettModeId;
  resolvedNumeratorId: string;
  points: RatioPoint[];
  gdpVintageDate: string;
}

export interface TrendFit {
  alpha: number;
  beta: number;
  sigma: number;
  originMs: number;
}

export type ValuationZoneId =
  | "significantly-undervalued"
  | "modestly-undervalued"
  | "fair"
  | "modestly-overvalued"
  | "significantly-overvalued";

export interface ZoneHit {
  id: ValuationZoneId;
  label: string;
  color: string;
}

export interface Extreme {
  ratio: number;
  date: string;
}

export interface BuffettChartProjection {
  points: ProjectedChartPoint[];
  overlays: ChartIndicatorOverlays;
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

export type BuffettSeriesLoader = (request: FredSeriesRequest) => Promise<FredSeriesData>;

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const GDP: SeriesDef = {
  seriesId: "GDP",
  scaleToBillions: 1,
  request: { limit: 340, sortOrder: "desc" },
};

export const WILSHIRE_NUMERATOR: SeriesDef = {
  seriesId: "WILL5000PRFC",
  scaleToBillions: 1,
  request: { limit: 4000, sortOrder: "desc" },
  fallbackSeriesId: "WILL5000PR",
};

export const Z1_NUMERATOR: SeriesDef = {
  seriesId: "NCBEILQ027S",
  scaleToBillions: 1 / 1000,
  request: { limit: 340, sortOrder: "desc" },
};

export const BUFFETT_MODES: { readonly [K in BuffettModeId]: ModeDef } = {
  wilshire: {
    id: "wilshire",
    label: "Wilshire 5000 (daily)",
    numerator: WILSHIRE_NUMERATOR,
    denominator: GDP,
    align: "interpolate-gdp",
    staleAfterMs: 5 * 24 * 60 * 60 * 1000,
  },
  z1: {
    id: "z1",
    label: "Z.1 corporate equities (quarterly)",
    numerator: Z1_NUMERATOR,
    denominator: GDP,
    align: "same-quarter",
    staleAfterMs: 150 * 24 * 60 * 60 * 1000,
  },
};

export const RANGE_WINDOWS_MS: { readonly [K in BuffettRangeId]: number | null } = {
  "10Y": 10 * MS_PER_YEAR,
  "25Y": 25 * MS_PER_YEAR,
  ALL: null,
};

export const ZONE_TABLE: readonly {
  max: number | null;
  id: ValuationZoneId;
  label: string;
}[] = [
  { max: 75, id: "significantly-undervalued", label: "Significantly Undervalued" },
  { max: 90, id: "modestly-undervalued", label: "Modestly Undervalued" },
  { max: 115, id: "fair", label: "Fair Valued" },
  { max: 135, id: "modestly-overvalued", label: "Modestly Overvalued" },
  { max: null, id: "significantly-overvalued", label: "Significantly Overvalued" },
];

function zoneColor(id: ValuationZoneId): string {
  switch (id) {
    case "significantly-undervalued":
      return colors.positive;
    case "modestly-undervalued":
      return blendHex(colors.bg, colors.positive, 0.55);
    case "fair":
      return colors.textBright;
    case "modestly-overvalued":
      return colors.warning;
    case "significantly-overvalued":
      return colors.negative;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export function seriesRequest(def: SeriesDef, seriesId = def.seriesId): FredSeriesRequest {
  return { seriesId, limit: def.request.limit, sortOrder: def.request.sortOrder };
}

export function uniqueSeriesDefs(
  modes: typeof BUFFETT_MODES = BUFFETT_MODES,
): SeriesDef[] {
  const seen = new Set<string>();
  const defs: SeriesDef[] = [];
  for (const mode of Object.values(modes)) {
    for (const def of [mode.numerator, mode.denominator]) {
      const key = def.seriesId.trim().toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      defs.push(def);
    }
  }
  return defs;
}

export function scaleObservations(
  def: SeriesDef,
  data: FredSeriesData,
): ScaledObs[] {
  const points: ScaledObs[] = [];
  for (const obs of data.observations) {
    if (obs.value == null || !Number.isFinite(obs.value)) continue;
    points.push({ date: obs.date, value: obs.value * def.scaleToBillions });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

function parseDateMs(date: string): number {
  return Date.parse(date);
}

function yearQuarter(date: string): string {
  const ms = parseDateMs(date);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

export function gdpVintageLabel(gdpVintageDate: string): string {
  const ms = parseDateMs(gdpVintageDate);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `GDP as of ${year}Q${quarter}`;
}

function ratioPoint(
  date: string,
  marketCapBillions: number,
  gdpBillions: number,
): RatioPoint {
  return {
    date,
    marketCapBillions,
    gdpBillions,
    ratio: (marketCapBillions / gdpBillions) * 100,
  };
}

export function interpolateGdpAligner(
  market: readonly ScaledObs[],
  gdp: readonly ScaledObs[],
): RatioPoint[] {
  if (gdp.length === 0 || market.length === 0) return [];
  const firstGdpMs = parseDateMs(gdp[0]!.date);
  const lastGdp = gdp[gdp.length - 1]!;
  const lastGdpMs = parseDateMs(lastGdp.date);
  const out: RatioPoint[] = [];

  for (const m of market) {
    const t = parseDateMs(m.date);
    if (t < firstGdpMs) continue;

    let gdpValue: number;
    if (t >= lastGdpMs) {
      gdpValue = lastGdp.value;
    } else {
      let i = 0;
      while (i + 1 < gdp.length && parseDateMs(gdp[i + 1]!.date) <= t) i += 1;
      const left = gdp[i]!;
      const right = gdp[i + 1];
      if (!right || parseDateMs(left.date) === t) {
        gdpValue = left.value;
      } else {
        const t0 = parseDateMs(left.date);
        const t1 = parseDateMs(right.date);
        const frac = (t - t0) / (t1 - t0);
        gdpValue = left.value + frac * (right.value - left.value);
      }
    }
    if (!(gdpValue > 0)) continue;
    out.push(ratioPoint(m.date, m.value, gdpValue));
  }
  return out;
}

export function sameQuarterAligner(
  market: readonly ScaledObs[],
  gdp: readonly ScaledObs[],
): RatioPoint[] {
  const gdpByQuarter = new Map<string, number>();
  for (const g of gdp) gdpByQuarter.set(yearQuarter(g.date), g.value);
  const out: RatioPoint[] = [];
  for (const m of market) {
    const gdpValue = gdpByQuarter.get(yearQuarter(m.date));
    if (gdpValue == null || !(gdpValue > 0)) continue;
    out.push(ratioPoint(m.date, m.value, gdpValue));
  }
  return out;
}

const ALIGNERS: {
  readonly [K in AlignmentRuleId]: (
    market: readonly ScaledObs[],
    gdp: readonly ScaledObs[],
  ) => RatioPoint[];
} = {
  "interpolate-gdp": interpolateGdpAligner,
  "same-quarter": sameQuarterAligner,
};

export function buildRatioSeries(
  mode: ModeDef,
  numerator: FredSeriesData,
  denominator: FredSeriesData,
  resolvedNumeratorId: string,
): RatioSeries {
  const market = scaleObservations(
    { ...mode.numerator, seriesId: resolvedNumeratorId },
    numerator,
  );
  const gdp = scaleObservations(mode.denominator, denominator);
  const points = ALIGNERS[mode.align](market, gdp);
  if (points.length === 0) throw new Error(`${mode.id}: no overlapping observations`);
  return {
    mode: mode.id,
    resolvedNumeratorId,
    points,
    gdpVintageDate: gdp.at(-1)!.date,
  };
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

export function classifyZone(ratio: number): ZoneHit {
  for (const row of ZONE_TABLE) {
    if (row.max == null || ratio < row.max) {
      return { id: row.id, label: row.label, color: zoneColor(row.id) };
    }
  }
  const last = ZONE_TABLE[ZONE_TABLE.length - 1]!;
  return { id: last.id, label: last.label, color: zoneColor(last.id) };
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function projectChart(
  visible: readonly RatioPoint[],
  fit: TrendFit,
): BuffettChartProjection {
  const points: ProjectedChartPoint[] = visible.map((p) => ({
    date: new Date(p.date),
    open: p.ratio,
    high: p.ratio,
    low: p.ratio,
    close: p.ratio,
    volume: 0,
  }));
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    yMin = Math.min(yMin, p.close);
    yMax = Math.max(yMax, p.close);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    yMin = 0;
    yMax = 1;
  }

  const middle: { index: number; value: number }[] = [];
  const upper2: { index: number; value: number }[] = [];
  const lower2: { index: number; value: number }[] = [];
  const upper1: { index: number; value: number }[] = [];
  const lower1: { index: number; value: number }[] = [];

  for (let i = 0; i < visible.length; i += 1) {
    const date = visible[i]!.date;
    const mid = trendAt(fit, date);
    const band = (k: number) => mid * Math.exp(k * fit.sigma);
    middle.push({ index: i, value: clamp(mid, yMin, yMax) });
    upper2.push({ index: i, value: clamp(band(2), yMin, yMax) });
    lower2.push({ index: i, value: clamp(band(-2), yMin, yMax) });
    upper1.push({ index: i, value: clamp(band(1), yMin, yMax) });
    lower1.push({ index: i, value: clamp(band(-1), yMin, yMax) });
  }

  const overlays: ChartIndicatorOverlays = {
    smaLines: [
      { period: 0, points: upper1, color: colors.textMuted },
      { period: 0, points: lower1, color: colors.textMuted },
    ],
    emaLines: [],
    bollinger: {
      middle,
      upper: upper2,
      lower: lower2,
      color: colors.textDim,
    },
    rsi: null,
    macd: null,
  };

  return { points, overlays };
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
    chart: projectChart(visible, trend),
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

export function gaugeSegmentsFromZones(): {
  from: number;
  to: number;
  label: string;
  color: string;
}[] {
  const maxGauge = 250;
  let from = 0;
  return ZONE_TABLE.map((row) => {
    const to = row.max == null ? maxGauge : row.max;
    const segment = {
      from,
      to: row.max == null ? maxGauge : to - 0.001,
      label: row.label,
      color: zoneColor(row.id),
    };
    from = row.max ?? maxGauge;
    return segment;
  });
}
