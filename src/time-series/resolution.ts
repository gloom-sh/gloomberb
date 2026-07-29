import type { ChartResolution, TimeRange } from "./range";
import { TIME_RANGES } from "./range";
import { isDateWindowWithinTimeRange } from "./date-window";

export type ManualChartResolution = Exclude<ChartResolution, "auto">;

export interface ChartResolutionSupport {
  resolution: ManualChartResolution;
  maxRange: TimeRange;
}

export const TIME_RANGE_ORDER: TimeRange[] = [...TIME_RANGES];

const CHART_RESOLUTION_ORDER: ChartResolution[] = [
  "auto",
  "1m",
  "5m",
  "15m",
  "30m",
  "45m",
  "1h",
  "1d",
  "1wk",
  "1mo",
];

const CHART_RESOLUTION_LABELS: Record<ChartResolution, string> = {
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

const TIME_RANGE_INDEX = new Map(TIME_RANGE_ORDER.map((range, index) => [range, index]));

function getTimeRangeIndex(range: TimeRange): number {
  return TIME_RANGE_INDEX.get(range) ?? 0;
}

function compareTimeRange(left: TimeRange, right: TimeRange): number {
  return getTimeRangeIndex(left) - getTimeRangeIndex(right);
}

function isChartResolution(value: unknown): value is ChartResolution {
  return CHART_RESOLUTION_ORDER.includes(value as ChartResolution);
}

function isManualChartResolution(value: unknown): value is ManualChartResolution {
  return value !== "auto" && CHART_RESOLUTION_ORDER.includes(value as ChartResolution);
}

export function normalizeChartResolution(value: unknown, fallback: ChartResolution = "auto"): ChartResolution {
  return isChartResolution(value) ? value : fallback;
}

export function getChartResolutionLabel(resolution: ChartResolution): string {
  return CHART_RESOLUTION_LABELS[resolution];
}

export function getPresetResolution(range: TimeRange): ManualChartResolution {
  return RANGE_PRESET_RESOLUTION[range];
}

export function getNextBufferRange(range: TimeRange): TimeRange {
  return RANGE_PRELOAD_BUFFER[range];
}

export function getExpandedBufferRange(
  bufferRange: TimeRange,
  resolution: ChartResolution,
  supportMap: ReadonlyMap<ManualChartResolution, TimeRange>,
): TimeRange | null {
  const nextCandidate = getNextBufferRange(bufferRange);
  const nextBufferRange = resolution === "auto"
    ? nextCandidate
    : clampTimeRangeToMaxRange(nextCandidate, supportMap.get(resolution) ?? bufferRange);
  return isTimeRangeAtOrBelow(nextBufferRange, bufferRange) ? null : nextBufferRange;
}

export function sortChartResolutions<T extends ChartResolution>(resolutions: readonly T[]): T[] {
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

export function getBestSupportedResolutionForVisibleWindow(
  window: { start: Date | null; end: Date | null } | null,
  support: readonly ChartResolutionSupport[] | ReadonlyMap<ManualChartResolution, TimeRange>,
  targetPointCount: number,
): ManualChartResolution | null {
  if (!window?.start || !window.end) return null;

  const spanMs = Math.max(window.end.getTime() - window.start.getTime(), 0);
  const dayCount = Math.max(spanMs / CHART_RESOLUTION_STEP_MS["1d"], 1 / 24);
  const supportedResolutions = sortChartResolutions(
    CHART_RESOLUTION_ORDER
      .filter((resolution): resolution is ManualChartResolution => resolution !== "auto")
      .filter((resolution) => {
        const maxRange = getSupportMaxRange(support, resolution);
        return maxRange !== null && isDateWindowWithinTimeRange(window.start!, window.end!, maxRange);
      }),
  );

  if (supportedResolutions.length === 0) return null;

  const minimumPointTarget = Math.max(targetPointCount, 1);
  for (const resolution of [...supportedResolutions].reverse()) {
    const estimatedPointCount = Math.max(dayCount * CHART_RESOLUTION_POINTS_PER_DAY[resolution], 1);
    if (estimatedPointCount >= minimumPointTarget) {
      return resolution;
    }
  }

  return supportedResolutions[0] ?? null;
}
