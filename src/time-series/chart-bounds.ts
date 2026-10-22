import {
  getTimeRangeForDateWindow,
  isDateWindowWithinTimeRange,
  subtractTimeRange,
} from "./date-window";
import {
  CHART_RESOLUTION_STEP_MS,
  getBestSupportedResolutionForVisibleWindow,
  getNextBufferRange,
  getSupportedPresetResolution,
  getSupportMaxRange,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import { TIME_RANGES, type TimeRange } from "./range";
import { maxStudyWarmupPoints } from "./studies";
import type { PriceComparison } from "./price-comparison";
import { resolutionForExplicitMarketPeriods } from "./market-resolution";
import { latestSessionStart, latestTradingSessionOpen, priorSessionClose } from "../market-data/market/trading-sessions";
import type {
  ChartSpec,
  ResolvedSeries,
  TimeSeriesPoint,
} from "./types";
import type { ChartResolveOptions } from "./resolve-context";

export interface DateBounds {
  start: number | null;
  /** Inclusive upper bound. */
  end: number | null;
}

export const DAY_MS = 24 * 60 * 60 * 1_000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function finiteDate(value: string | Date | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function inclusiveEndDate(value: string | Date | undefined): Date | null {
  const parsed = finiteDate(value);
  if (!parsed) return null;
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value.trim())
    ? new Date(parsed.getTime() + DAY_MS - 1)
    : parsed;
}

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function explicitBounds(spec: ChartSpec): DateBounds | null {
  const explicitStart = finiteDate(spec.viewport.dateWindow?.start);
  const explicitEnd = inclusiveEndDate(spec.viewport.dateWindow?.end);
  if (!explicitStart || !explicitEnd || explicitStart.getTime() > explicitEnd.getTime()) return null;
  return { start: explicitStart.getTime(), end: explicitEnd.getTime() };
}

/** Calendar range limits use the authored dates; observation filters include the final day. */
export function rangeDurationBounds(spec: ChartSpec, bounds: DateBounds): DateBounds {
  const window = spec.viewport.dateWindow;
  if (!window || !DATE_ONLY_PATTERN.test(window.start) || !DATE_ONLY_PATTERN.test(window.end)
    || bounds.end !== inclusiveEndDate(window.end)?.getTime()) return bounds;
  return { ...bounds, end: finiteDate(window.end)!.getTime() };
}

export function requestedBounds(spec: ChartSpec, latestObservation: Date): DateBounds {
  const explicit = explicitBounds(spec);
  if (explicit) return explicit;
  return {
    start: spec.viewport.range === "ALL"
      ? null
      : subtractTimeRange(latestObservation, spec.viewport.range).getTime(),
    end: latestObservation.getTime(),
  };
}

export function runtimeAutoBounds(options: ChartResolveOptions): DateBounds | null {
  const start = options.autoViewport?.start.getTime();
  const end = options.autoViewport?.end.getTime();
  return typeof start === "number"
      && Number.isFinite(start)
      && typeof end === "number"
      && Number.isFinite(end)
      && start <= end
    ? { start, end }
    : null;
}

export function runtimeRequestBounds(options: ChartResolveOptions): DateBounds | null {
  const start = options.requestViewport?.start.getTime();
  const end = options.requestViewport?.end.getTime();
  return typeof start === "number"
      && Number.isFinite(start)
      && typeof end === "number"
      && Number.isFinite(end)
      && start <= end
    ? { start, end }
    : null;
}

export function sameBounds(left: DateBounds | null, right: DateBounds | null): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

function boundsRange(bounds: DateBounds): TimeRange {
  if (bounds.start === null || bounds.end === null) return "ALL";
  return getTimeRangeForDateWindow({
    start: new Date(bounds.start),
    end: new Date(bounds.end),
  });
}

export function requestResolution(
  spec: ChartSpec,
  bounds: DateBounds,
  calculationSeriesIds: ReadonlySet<string>,
  options: ChartResolveOptions,
  sharedSupport: readonly ChartResolutionSupport[],
  provisionalSupport = false,
): ManualChartResolution {
  const duration = rangeDurationBounds(spec, bounds);
  if (spec.viewport.resolution === "auto" && spec.studies.some((study) => study.kind === "realized-vol" && study.visible !== false)) {
    // A 252-session estimator must see daily observations even on a long chart.
    const maxRange = getSupportMaxRange(sharedSupport, "1d");
    if (sharedSupport.length === 0 || provisionalSupport || maxRange === "ALL"
      || (maxRange !== null && duration.start !== null && duration.end !== null
        && isDateWindowWithinTimeRange(new Date(duration.start), new Date(duration.end), maxRange))) return "1d";
  }
  if (spec.viewport.resolution !== "auto") {
    const maxRange = getSupportMaxRange(sharedSupport, spec.viewport.resolution);
    // A placeholder list cannot rule out a manual pick; the real list decides
    // on the next pass.
    const supported = sharedSupport.length === 0
      || provisionalSupport
      || maxRange === "ALL"
      || (
        maxRange !== null
        && duration.start !== null
        && duration.end !== null
        && isDateWindowWithinTimeRange(
          new Date(duration.start),
          new Date(duration.end),
          maxRange,
        )
      );
    if (supported) return spec.viewport.resolution;
  }
  const runtimeBounds = runtimeAutoBounds(options);
  const adaptive = runtimeBounds && runtimeBounds.start !== null && runtimeBounds.end !== null
    ? getBestSupportedResolutionForVisibleWindow(
        { start: new Date(runtimeBounds.start), end: new Date(runtimeBounds.end) },
        sharedSupport,
        options.targetPointCount ?? 120,
        options.currentResolution,
      )
    : null;
  const preferred = adaptive
    ?? getSupportedPresetResolution(
      explicitBounds(spec) ? boundsRange(duration) : spec.viewport.range,
      provisionalSupport ? [] : sharedSupport,
      duration.start !== null && duration.end !== null
        ? { start: new Date(duration.start), end: new Date(duration.end) }
        : null,
    );
  const activeSeries = spec.series.filter((entry) => calculationSeriesIds.has(entry.id));
  return resolutionForExplicitMarketPeriods(preferred, activeSeries);
}

export function calculationBounds(
  spec: ChartSpec,
  visibleBounds: DateBounds,
  resolution: ManualChartResolution,
): DateBounds {
  if (visibleBounds.start === null) return visibleBounds;
  const warmupPoints = maxStudyWarmupPoints(spec.studies);

  const duration = rangeDurationBounds(spec, visibleBounds);
  const visibleEnd = duration.end ?? visibleBounds.start;
  const bufferedRange = getNextBufferRange(boundsRange(duration));
  let start = bufferedRange === "ALL"
    ? subtractTimeRange(new Date(visibleEnd), "ALL").getTime()
    : subtractTimeRange(new Date(visibleEnd), bufferedRange).getTime();

  if (warmupPoints > 0) {
    // Calendar gaps and closed sessions mean N observations often span more
    // than N nominal bars. The doubled point window is a bounded safety margin.
    const pointWarmup = warmupPoints * CHART_RESOLUTION_STEP_MS[resolution] * 2;
    start = Math.min(start, visibleBounds.start - pointWarmup);
  }
  return { start: Math.min(start, visibleBounds.start), end: visibleBounds.end };
}

/**
 * How far past a view moved into the past its history reaches: half a view,
 * as far as the interval's longest window allows with the view still in it.
 * Those are the bars a pan forward meets first. Without them, a view whose
 * bars were loaded for it alone (a zoom to finer bars, then a pan) ends where
 * they do, and a pan forward stops there with nothing to ask for.
 */
export function barsAhead(view: DateBounds, maxRange: TimeRange | null, now: number): number {
  if (view.start === null || view.end === null || view.end >= now) return 0;
  const room = maxRange && maxRange !== "ALL"
    ? view.start - subtractTimeRange(new Date(view.end), maxRange).getTime()
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min((view.end - view.start) / 2, room, now - view.end));
}

export function trailingRangeForStart(start: number | null, referenceDate: Date): TimeRange {
  if (start === null) return "ALL";
  for (const range of TIME_RANGES) {
    if (range === "ALL" || start >= subtractTimeRange(referenceDate, range).getTime()) return range;
  }
  return "ALL";
}

export function exclusiveEnd(bounds: DateBounds): Date | null {
  return bounds.end === null ? null : new Date(bounds.end + 1);
}

export function filterPoints(points: readonly TimeSeriesPoint[], bounds: DateBounds): TimeSeriesPoint[] {
  return points.filter((point) => {
    const time = point.date.getTime();
    return Number.isFinite(time)
      && (bounds.start === null || time >= bounds.start)
      && (bounds.end === null || time <= bounds.end);
  });
}

export function comparisonDisplayBounds(bounds: DateBounds, comparison: PriceComparison | null): DateBounds {
  if (!comparison || comparison.start === null || comparison.end === null) return bounds;
  // A date-only selection can include a local session that began on the prior
  // UTC day, and a preset range's base close can be before its window (a month
  // before a Monday is a Sunday, so the Friday). Keep both visible.
  return {
    start: bounds.start === null ? null : Math.min(bounds.start, comparison.start),
    end: bounds.end === null ? null : Math.max(bounds.end, comparison.end),
  };
}

/**
 * An untouched market chart ends at its newest bar. A quote that arrives just
 * after the reference time moves it on; a closed market (a night, a weekend)
 * moves it back, so the plot does not end in an empty stretch that the first
 * pan would then collapse.
 */
export function followLatestMarketObservation(
  bounds: DateBounds,
  series: readonly ResolvedSeries[],
): DateBounds {
  if (bounds.end === null) return bounds;
  let latest = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    if (entry.timeBasis?.kind !== "market") continue;
    for (const point of entry.points) {
      const timestamp = point.date.getTime();
      if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
    }
  }
  if (!Number.isFinite(latest) || latest === bounds.end) return bounds;
  const shift = latest - bounds.end;
  return {
    start: bounds.start === null ? null : bounds.start + shift,
    end: latest,
  };
}

/**
 * The dates a capability series (CHOKE's transits) is asked for. A view the
 * user panned or zoomed keeps the range's dates loaded too: the chart's
 * navigation stops at the newest observation it has, so a series asked for
 * the moved view alone ended where the view did, and the view could never go
 * forward to the newest data again, not even by zooming out.
 */
export function capabilityRequestBounds(view: DateBounds, range: DateBounds, moved: boolean): DateBounds {
  if (!moved) return view;
  return {
    start: view.start === null || range.start === null ? null : Math.min(view.start, range.start),
    end: view.end === null || range.end === null ? null : Math.max(view.end, range.end),
  };
}

/**
 * A chart of capability series alone (CHOKE's vessel transits) ends at its
 * newest observation, not today: such data is published days late, and an
 * axis running on to today would read as days with nothing in them. The
 * start stays where the range put it, so no empty span opens on the left.
 */
export function endAtNewestObservation(bounds: DateBounds, series: readonly ResolvedSeries[]): DateBounds {
  if (bounds.end === null) return bounds;
  let newest = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    for (const point of entry.points) {
      const timestamp = point.date.getTime();
      if (point.value !== null && Number.isFinite(timestamp) && timestamp > newest) newest = timestamp;
    }
  }
  if (!Number.isFinite(newest) || newest >= bounds.end || (bounds.start !== null && newest <= bounds.start)) return bounds;
  return { start: bounds.start, end: newest };
}

/**
 * 1D shows the latest trading session of the chart's first market listing,
 * from its open to the newest bar, with the close before it as a reference.
 * Null keeps the rolling day: crypto, FX and venues without known hours.
 * The reference is the quote's previous close when the quote is from the
 * session shown, as the legend's change is; otherwise the last bar of the
 * session before.
 */
export function latestSessionView(
  primary: ResolvedSeries | undefined,
  marketSeries: readonly ResolvedSeries[],
  extendedHours: boolean,
  quoteReference: { close: number; time: number } | undefined,
): { bounds: DateBounds; priorClose: number | null } | null {
  if (!primary?.listing) return null;
  const bars = primary.points.flatMap((point) => {
    const close = point.close ?? point.value;
    const time = point.date.getTime();
    return typeof close === "number" && Number.isFinite(close) && Number.isFinite(time) ? [{ time, close }] : [];
  });
  const latest = bars.at(-1)?.time;
  if (latest === undefined) return null;
  const { symbol, exchange } = primary.listing;
  const open = latestSessionStart(symbol, exchange, latest, { extendedHours });
  if (open === null) return null;
  // The axis starts at the session's first bar, which a quiet pre-market can leave well after the open.
  const start = bars.find((bar) => bar.time >= open)?.time ?? open;
  // Another listing on the chart can trade later than the primary one.
  let end = latest;
  for (const entry of marketSeries) {
    const last = entry.points.at(-1)?.date.getTime();
    if (last !== undefined && Number.isFinite(last) && last > end) end = last;
  }
  const regularOpen = latestTradingSessionOpen(symbol, exchange, latest);
  const quoteOpen = quoteReference ? latestTradingSessionOpen(symbol, exchange, quoteReference.time) : null;
  const priorClose = quoteReference && regularOpen !== null && quoteOpen === regularOpen
    ? quoteReference.close
    : priorSessionClose(bars, open, symbol, exchange);
  return { bounds: { start, end }, priorClose };
}
