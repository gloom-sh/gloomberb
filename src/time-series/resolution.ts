import type { ChartBarSizeUnit, ChartResolution, CustomChartResolution, TimeRange } from "./range";
import { CHART_RESOLUTIONS, TIME_RANGES } from "./range";
import { isDateWindowWithinTimeRange } from "./date-window";

/** The bar sizes sources and brokers serve, and the only ones they are asked for. */
export type ManualChartResolution = "1m" | "5m" | "15m" | "30m" | "45m" | "1h" | "1d" | "1wk" | "1mo";
/** Any bar size a chart draws: one a source serves, or one built from them. */
export type ChartBarSize = Exclude<ChartResolution, "auto">;

export interface ChartResolutionSupport {
  resolution: ManualChartResolution;
  maxRange: TimeRange;
}

/** @deprecated Use `TIME_RANGES` from `gloomberb/time-series`; this is the same array. */
export const TIME_RANGE_ORDER = TIME_RANGES;
const CHART_RESOLUTION_ORDER = CHART_RESOLUTIONS;

const CHART_RESOLUTION_LABELS: Record<ManualChartResolution | "auto", string> = {
  auto: "AUTO",
  "1m": "1M",
  "5m": "5M",
  "15m": "15M",
  "30m": "30M",
  "45m": "45M",
  "1h": "1H",
  "1d": "1D",
  "1wk": "1W",
  "1mo": "1MO",
};

const RANGE_PRESET_RESOLUTION: Record<TimeRange, ManualChartResolution> = {
  "1D": "1m",
  "1W": "5m",
  "1M": "15m",
  "3M": "1h",
  "6M": "1d",
  "1Y": "1d",
  "5Y": "1wk",
  "ALL": "1mo",
};

/**
 * The bar size a price history for a range is served in, unlike the chart
 * presets above: what `gloomberb history` and the historical prices pane get.
 */
export const RANGE_HISTORY_RESOLUTION: Readonly<Record<TimeRange, ManualChartResolution>> = {
  "1D": "5m",
  "1W": "1h",
  "1M": "1d",
  "3M": "1d",
  "6M": "1d",
  "1Y": "1d",
  "5Y": "1wk",
  "ALL": "1mo",
};

const RANGE_PRELOAD_BUFFER: Record<TimeRange, TimeRange> = {
  "1D": "1W",
  "1W": "1M",
  "1M": "3M",
  "3M": "6M",
  "6M": "1Y",
  "1Y": "5Y",
  "5Y": "ALL",
  "ALL": "ALL",
};

export const CHART_RESOLUTION_STEP_MS: Record<ManualChartResolution, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "45m": 45 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1wk": 7 * 24 * 60 * 60_000,
  "1mo": 30 * 24 * 60 * 60_000,
};

export type BarIntervalUnit = "min" | "h" | "day" | "week" | "month";

/** One bar of each unit in milliseconds; a month counts as 30 days. */
export const BAR_INTERVAL_UNIT_MS: Readonly<Record<BarIntervalUnit, number>> = {
  min: 60_000,
  h: 60 * 60_000,
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
};

/**
 * Reads a bar size such as "5m", "1h", "1wk" or "3 months" as a positive
 * count of one unit; null for anything else.
 */
export function parseBarInterval(value: unknown): { count: number; unit: BarIntervalUnit } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|mo|month|months)$/i.exec(value.trim());
  const count = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(count) || count <= 0) return null;
  const unit = match[2]!.toLowerCase();
  return {
    count,
    unit: /^(mo|month)/.test(unit) ? "month" : /^(w|wk|week)/.test(unit) ? "week" : /^(d|day)/.test(unit) ? "day" : /^(h|hr|hour)/.test(unit) ? "h" : "min",
  };
}

const CHART_RESOLUTION_POINTS_PER_DAY: Record<ManualChartResolution, number> = {
  "1m": 390,
  "5m": 78,
  "15m": 26,
  "30m": 13,
  "45m": 9,
  "1h": 7,
  "1d": 1,
  "1wk": 1 / 5,
  "1mo": 1 / 21,
};

const TIME_RANGE_APPROXIMATE_DAYS: Record<TimeRange, number> = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "3M": 90,
  "6M": 180,
  "1Y": 365,
  "5Y": 5 * 365,
  "ALL": 50 * 365,
};

const MINIMUM_USEFUL_CHART_POINTS = 2;

const TIME_RANGE_INDEX = new Map(TIME_RANGES.map((range, index) => [range, index]));

function getTimeRangeIndex(range: TimeRange): number {
  return TIME_RANGE_INDEX.get(range) ?? 0;
}

function compareTimeRange(left: TimeRange, right: TimeRange): number {
  return getTimeRangeIndex(left) - getTimeRangeIndex(right);
}

export function isManualChartResolution(value: unknown): value is ManualChartResolution {
  return value !== "auto" && CHART_RESOLUTION_ORDER.includes(value as ChartResolution);
}

const BAR_SIZE_UNIT_MS: Readonly<Record<ChartBarSizeUnit, number>> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
  wk: 7 * 24 * 60 * 60_000,
  mo: 30 * 24 * 60 * 60_000,
};

/** The longest bar of each unit: a day of minutes or hours, a year of days, weeks or months. */
const BAR_SIZE_MAX_COUNT: Readonly<Record<ChartBarSizeUnit, number>> = { m: 1440, h: 24, d: 365, wk: 52, mo: 12 };

const BAR_SIZE_UNITS: Readonly<Record<string, ChartBarSizeUnit>> = {
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
  w: "wk", wk: "wk", week: "wk", weeks: "wk",
  mo: "mo", mon: "mo", month: "mo", months: "mo",
};

/** A bar size in its one stored form: `90m`, `4h` (not `240m`), `2d`, `1wk`, `3mo`. */
function canonicalBarSize(count: number, unit: ChartBarSizeUnit): ChartBarSize | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  if (unit === "m" && count % 60 === 0) return canonicalBarSize(count / 60, "h");
  if (count > BAR_SIZE_MAX_COUNT[unit]) return null;
  return `${count}${unit}` as ChartBarSize;
}

/** A stored bar size's count and unit; null for anything that is not one. */
export function chartBarSizeParts(size: unknown): { count: number; unit: ChartBarSizeUnit } | null {
  if (typeof size !== "string") return null;
  const match = /^([1-9]\d{0,3})(m|h|d|wk|mo)$/.exec(size);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = match[2] as ChartBarSizeUnit;
  return canonicalBarSize(count, unit) === size ? { count, unit } : null;
}

/** A stored bar size (`4h`, `2d`, `1wk`); `auto` is not one. */
function isChartBarSize(value: unknown): value is ChartBarSize {
  return chartBarSizeParts(value) !== null;
}

/** Any value a chart's resolution may hold: `auto` or a stored bar size. */
export function isChartResolution(value: unknown): value is ChartResolution {
  return value === "auto" || isChartBarSize(value);
}

/** A bar size the source does not serve, which the chart builds from one it does. */
export function isCustomChartResolution(value: unknown): value is CustomChartResolution {
  return isChartBarSize(value) && !isManualChartResolution(value);
}

/**
 * Reads a bar size as typed: `10m`, `10 min`, `4h`, `240` (minutes), `2D`,
 * `3 days`, `2W`, `3mo`, `1Y`. A capital `M` alone is read as nothing: the
 * chart labels months `M` and the command line minutes `1M`, so `3M` could be
 * either. Null for anything else, and for bars longer than a day of minutes
 * or hours, a year of days or weeks, or twelve months.
 */
export function parseChartBarSize(value: unknown): ChartBarSize | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,4})\s*([A-Za-z]*)$/.exec(value.trim());
  if (!match) return null;
  const count = Number(match[1]);
  const written = match[2]!;
  if (written === "") return canonicalBarSize(count, "m");
  if (written === "M") return null;
  const lower = written.toLowerCase();
  if (lower === "y" || lower === "yr" || lower === "year" || lower === "years") return canonicalBarSize(count * 12, "mo");
  const unit = BAR_SIZE_UNITS[lower];
  return unit ? canonicalBarSize(count, unit) : null;
}

/** A chart resolution as typed or stored: `auto`, or any bar size `parseChartBarSize` reads. */
export function parseChartResolution(value: unknown): ChartResolution | null {
  if (typeof value === "string" && value.trim().toLowerCase() === "auto") return "auto";
  return parseChartBarSize(value);
}

/** How long one bar is; a month counts as 30 days. */
export function chartBarSizeStepMs(size: ChartBarSize): number {
  const parts = chartBarSizeParts(size);
  return parts ? parts.count * BAR_SIZE_UNIT_MS[parts.unit] : Number.NaN;
}

/** Source bar sizes that can make up minute and hour bars, longest first. */
const INTRADAY_SOURCE_RESOLUTIONS: readonly ManualChartResolution[] = ["1h", "45m", "30m", "15m", "5m", "1m"];

/**
 * The bars a source serves that a bar size is built from: the longest that
 * divide it (1h for 4h, 5m for 10m, 30m for 90m), among those the source
 * serves when `support` says. Day, week and month multiples come from 1d, 1wk
 * and 1mo bars. `openMinute`, minutes after local midnight, is when sessions
 * open on a listing whose source bars start on the clock rather than at the
 * open (futures): its source bars must also divide it, or a bar would straddle
 * the open. A bar size the source serves is its own.
 */
export function chartBarSizeSource(
  size: ChartBarSize,
  support: readonly ChartResolutionSupport[] = [],
  openMinute: number | null = null,
): ManualChartResolution {
  if (isManualChartResolution(size)) return size;
  const parts = chartBarSizeParts(size);
  if (!parts) return "1d";
  if (parts.unit === "d") return "1d";
  if (parts.unit === "wk") return "1wk";
  if (parts.unit === "mo") return "1mo";
  const minutes = parts.unit === "h" ? parts.count * 60 : parts.count;
  const candidates = INTRADAY_SOURCE_RESOLUTIONS.filter((resolution) => {
    const step = CHART_RESOLUTION_STEP_MS[resolution] / 60_000;
    return minutes % step === 0 && (openMinute === null || openMinute % step === 0);
  });
  const served = support.length > 0
    ? candidates.find((resolution) => getSupportMaxRange(support, resolution) !== null)
    : undefined;
  return served ?? candidates[0] ?? "1m";
}

/**
 * Every bar size the chart lists, shortest first: the ones sources serve and
 * the ones most asked for that it builds from them. Any other is typed in.
 */
export const CHART_BAR_SIZE_PRESETS: readonly ChartBarSize[] = [
  "1m", "5m", "10m", "15m", "30m", "45m", "1h", "2h", "4h", "1d", "2d", "3d", "1wk", "1mo",
];

/** Orders bar sizes from the shortest bar to the longest. */
export function sortChartBarSizes<T extends ChartBarSize>(sizes: readonly T[]): T[] {
  return [...sizes].sort((left, right) => chartBarSizeStepMs(left) - chartBarSizeStepMs(right));
}

/** @deprecated Slated for removal. Check the value with `isChartResolution` instead. */
export function normalizeChartResolution(value: unknown, fallback: ChartResolution = "auto"): ChartResolution {
  return isChartResolution(value) ? value : fallback;
}

const CUSTOM_BAR_UNIT_LABELS: Readonly<Record<ChartBarSizeUnit, string>> = { m: "M", h: "H", d: "D", wk: "W", mo: "MO" };

export function getChartResolutionLabel(resolution: ChartResolution): string {
  if (isManualChartResolution(resolution) || resolution === "auto") return CHART_RESOLUTION_LABELS[resolution];
  const parts = chartBarSizeParts(resolution);
  return parts ? `${parts.count}${CUSTOM_BAR_UNIT_LABELS[parts.unit]}` : String(resolution).toUpperCase();
}

export function getPresetResolution(range: TimeRange): ManualChartResolution {
  return RANGE_PRESET_RESOLUTION[range];
}

/**
 * The range preset, or the nearest coarser interval the sources actually serve
 * for that window. A 1D chart on a source without 1m bars gets 5m instead of
 * a request that can only fail. Empty support means unknown, so the preset
 * stands.
 */
export function getSupportedPresetResolution(
  range: TimeRange,
  support: readonly ChartResolutionSupport[],
  window?: { start: Date | null; end: Date | null } | null,
): ManualChartResolution {
  const preset = RANGE_PRESET_RESOLUTION[range];
  if (support.length === 0) return preset;
  const start = window?.start ?? null;
  const end = window?.end ?? null;
  const covers = (maxRange: TimeRange) => (
    start && end && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
      ? isDateWindowWithinTimeRange(start, end, maxRange)
      : isTimeRangeAtOrBelow(range, maxRange)
  );
  const presetMaxRange = getSupportMaxRange(support, preset);
  if (presetMaxRange !== null && covers(presetMaxRange)) return preset;
  const presetIndex = CHART_RESOLUTION_ORDER.indexOf(preset);
  const coarser = sortChartResolutionSupport(normalizeChartResolutionSupport(support))
    .find((entry) => CHART_RESOLUTION_ORDER.indexOf(entry.resolution) > presetIndex && covers(entry.maxRange));
  return coarser?.resolution ?? preset;
}

export function getNextBufferRange(range: TimeRange): TimeRange {
  return RANGE_PRELOAD_BUFFER[range];
}

/** @deprecated Slated for removal. Combine `getNextBufferRange` with `clampTimeRangeToMaxRange` instead. */
export function getExpandedBufferRange(
  bufferRange: TimeRange,
  resolution: ChartResolution,
  supportMap: ReadonlyMap<ManualChartResolution, TimeRange>,
): TimeRange | null {
  const nextCandidate = getNextBufferRange(bufferRange);
  const nextBufferRange = resolution === "auto"
    ? nextCandidate
    : clampTimeRangeToMaxRange(nextCandidate, supportMap.get(chartBarSizeSource(resolution)) ?? bufferRange);
  return isTimeRangeAtOrBelow(nextBufferRange, bufferRange) ? null : nextBufferRange;
}

export function sortChartResolutions<T extends "auto" | ManualChartResolution>(resolutions: readonly T[]): T[] {
  return [...resolutions].sort((left, right) => (
    CHART_RESOLUTION_ORDER.indexOf(left) - CHART_RESOLUTION_ORDER.indexOf(right)
  ));
}

function sortChartResolutionSupport(support: readonly ChartResolutionSupport[]): ChartResolutionSupport[] {
  return [...support].sort((left, right) => (
    CHART_RESOLUTION_ORDER.indexOf(left.resolution) - CHART_RESOLUTION_ORDER.indexOf(right.resolution)
  ));
}

export function normalizeChartResolutionSupport(support: readonly ChartResolutionSupport[]): ChartResolutionSupport[] {
  const byResolution = new Map<ManualChartResolution, TimeRange>();
  for (const entry of support) {
    if (!isManualChartResolution(entry.resolution)) continue;
    const current = byResolution.get(entry.resolution);
    byResolution.set(
      entry.resolution,
      current ? (compareTimeRange(current, entry.maxRange) >= 0 ? current : entry.maxRange) : entry.maxRange,
    );
  }
  return sortChartResolutionSupport(
    [...byResolution.entries()].map(([resolution, maxRange]) => ({ resolution, maxRange })),
  );
}

/** provider-shaped support used for first paint when broker/provider support is async. */
export const DEFAULT_CHART_RESOLUTION_SUPPORT: ChartResolutionSupport[] = normalizeChartResolutionSupport([
  { resolution: "5m", maxRange: "1W" },
  { resolution: "15m", maxRange: "1M" },
  { resolution: "1h", maxRange: "3M" },
  { resolution: "1d", maxRange: "5Y" },
  { resolution: "1wk", maxRange: "ALL" },
  { resolution: "1mo", maxRange: "ALL" },
]);

export function intersectChartResolutionSupport(
  supportSets: Array<readonly ChartResolutionSupport[]>,
): ChartResolutionSupport[] {
  if (supportSets.length === 0) return [];
  const normalized = supportSets.map((support) => normalizeChartResolutionSupport(support));
  const first = normalized[0] ?? [];
  return sortChartResolutionSupport(first.flatMap((entry) => {
    let maxRange = entry.maxRange;
    for (const set of normalized.slice(1)) {
      const match = set.find((candidate) => candidate.resolution === entry.resolution);
      if (!match) return [];
      maxRange = minTimeRange(maxRange, match.maxRange);
    }
    return [{ resolution: entry.resolution, maxRange }];
  }));
}

export function getSupportMaxRange(
  support: readonly ChartResolutionSupport[] | ReadonlyMap<ManualChartResolution, TimeRange>,
  resolution: ManualChartResolution,
): TimeRange | null {
  if (!Array.isArray(support)) {
    return (support as ReadonlyMap<ManualChartResolution, TimeRange>).get(resolution) ?? null;
  }
  return normalizeChartResolutionSupport(support).find((entry) => entry.resolution === resolution)?.maxRange ?? null;
}

function viewportSpanMs(range: TimeRange, dateWindow?: { start: string | Date; end: string | Date }): number {
  const start = dateWindow ? new Date(dateWindow.start).getTime() : Number.NaN;
  const end = dateWindow ? new Date(dateWindow.end).getTime() : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && start <= end
    ? end - start
    : TIME_RANGE_APPROXIMATE_DAYS[range] * CHART_RESOLUTION_STEP_MS["1d"];
}

/**
 * The bar sizes of `sizes` a chart of this range or window can draw: each
 * one's source bars reach back over it, and it holds at least two bars.
 */
export function getSupportedChartBarSizesForViewport<T extends ChartBarSize>(
  range: TimeRange,
  support: readonly ChartResolutionSupport[],
  sizes: readonly T[],
  dateWindow?: { start: string | Date; end: string | Date },
  openMinute: number | null = null,
): T[] {
  const served = new Set<ManualChartResolution>(getSupportedChartResolutionsForViewport(range, support, dateWindow));
  const span = viewportSpanMs(range, dateWindow);
  return sizes.filter((size) => served.has(chartBarSizeSource(size, support, openMinute))
    && span / chartBarSizeStepMs(size) >= MINIMUM_USEFUL_CHART_POINTS);
}

export function getSupportedChartResolutionsForViewport(
  range: TimeRange,
  support: readonly ChartResolutionSupport[],
  dateWindow?: { start: string | Date; end: string | Date },
): ManualChartResolution[] {
  const start = dateWindow ? new Date(dateWindow.start) : null;
  const end = dateWindow ? new Date(dateWindow.end) : null;
  const hasValidDateWindow = !!start
    && Number.isFinite(start.getTime())
    && !!end
    && Number.isFinite(end.getTime())
    && start.getTime() <= end.getTime();
  const spanMs = viewportSpanMs(range, dateWindow);
  return normalizeChartResolutionSupport(support)
    .filter((entry) => (
      hasValidDateWindow
        ? isDateWindowWithinTimeRange(start, end, entry.maxRange)
        : isTimeRangeAtOrBelow(range, entry.maxRange)
    ))
    .filter((entry) => (
      spanMs / CHART_RESOLUTION_STEP_MS[entry.resolution]
        >= MINIMUM_USEFUL_CHART_POINTS
    ))
    .map((entry) => entry.resolution);
}

function minTimeRange(left: TimeRange, right: TimeRange): TimeRange {
  return compareTimeRange(left, right) <= 0 ? left : right;
}

function isTimeRangeAtOrBelow(candidate: TimeRange, maxRange: TimeRange): boolean {
  return compareTimeRange(candidate, maxRange) <= 0;
}

export function clampTimeRangeToMaxRange(range: TimeRange, maxRange: TimeRange): TimeRange {
  return isTimeRangeAtOrBelow(range, maxRange) ? range : maxRange;
}

export function isIntradayResolution(resolution: ManualChartResolution): boolean {
  return resolution === "1m"
    || resolution === "5m"
    || resolution === "15m"
    || resolution === "30m"
    || resolution === "45m"
    || resolution === "1h";
}

/**
 * @deprecated Slated for removal. Compare the range with
 * `getSupportMaxRange(support, getPresetResolution(range))` instead.
 */
export function isRangePresetSupported(
  range: TimeRange,
  support: readonly ChartResolutionSupport[] | readonly ManualChartResolution[],
): boolean {
  const resolution = RANGE_PRESET_RESOLUTION[range];
  if (support.length === 0) return false;
  if (typeof support[0] === "string") {
    return (support as readonly ManualChartResolution[]).includes(resolution);
  }
  const maxRange = getSupportMaxRange(support as readonly ChartResolutionSupport[], resolution);
  return maxRange !== null && isTimeRangeAtOrBelow(range, maxRange);
}

const INTRADAY_TRADING_DAY_RATIO = 5 / 7;
/** Bars packed tighter than the target cost more than bars spread wider. */
const DENSE_SCORE_PENALTY = 1.5;
/** Score margin a candidate must win by before the active resolution changes. */
const RESOLUTION_SWITCH_HYSTERESIS = 0.35;

function estimateVisiblePointCount(resolution: ManualChartResolution, spanMs: number): number {
  const calendarDays = Math.max(spanMs / CHART_RESOLUTION_STEP_MS["1d"], 1 / 24);
  // Intraday bars only exist on trading days, so a multi-day window holds
  // about five sessions a week. Anything up to a day is one session.
  const days = isIntradayResolution(resolution) && calendarDays > 1
    ? Math.max(calendarDays * INTRADAY_TRADING_DAY_RATIO, 1)
    : calendarDays;
  return Math.max(days * CHART_RESOLUTION_POINTS_PER_DAY[resolution], 1);
}

function resolutionFitScore(estimatedPointCount: number, targetPointCount: number): number {
  const ratio = estimatedPointCount / targetPointCount;
  return ratio > 1 ? Math.log(ratio) * DENSE_SCORE_PENALTY : -Math.log(ratio);
}

/**
 * Picks the supported resolution whose bar count sits closest to the target
 * on a log scale, leaning toward fewer bars. A current resolution is kept
 * until another candidate is clearly better, so a small zoom does not swap
 * the whole data set.
 */
export function getBestSupportedResolutionForVisibleWindow(
  window: { start: Date | null; end: Date | null } | null,
  support: readonly ChartResolutionSupport[] | ReadonlyMap<ManualChartResolution, TimeRange>,
  targetPointCount: number,
  currentResolution?: ManualChartResolution | null,
): ManualChartResolution | null {
  if (!window?.start || !window.end) return null;

  const spanMs = Math.max(window.end.getTime() - window.start.getTime(), 0);
  const supportedResolutions = sortChartResolutions(
    CHART_RESOLUTION_ORDER
      .filter((resolution): resolution is ManualChartResolution => resolution !== "auto")
      .filter((resolution) => {
        const maxRange = getSupportMaxRange(support, resolution);
        return maxRange !== null && isDateWindowWithinTimeRange(window.start!, window.end!, maxRange);
      }),
  );
  if (supportedResolutions.length === 0) return null;

  const target = Math.max(targetPointCount, 1);
  const scores = new Map(supportedResolutions.map((resolution) => [
    resolution,
    resolutionFitScore(estimateVisiblePointCount(resolution, spanMs), target),
  ] as const));
  let best = supportedResolutions[0]!;
  for (const resolution of supportedResolutions) {
    if (scores.get(resolution)! <= scores.get(best)!) best = resolution;
  }
  if (currentResolution && scores.has(currentResolution)) {
    const currentScore = scores.get(currentResolution)!;
    if (currentScore <= scores.get(best)! + RESOLUTION_SWITCH_HYSTERESIS) return currentResolution;
  }
  return best;
}
