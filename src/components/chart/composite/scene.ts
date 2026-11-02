import type {
  ChartPanelSpec,
  PanelScale,
  ResolvedSeries,
  TimeSeriesPoint,
} from "../../../time-series/types";
import { effectiveTimeSeriesPointTime, sortedUniquePoints, timeSeriesObservationKey } from "../../../time-series/alignment";
import type {
  BuildCompositeChartSceneOptions,
  CompositeAxisDomain,
  CompositeAxisSide,
  CompositeChartScene,
  CompositeCursorValue,
  CompositePanelScene,
  CompositeProjectedPoint,
} from "./types";
import {
  buildCompositeTimeScale,
  COMPOSITE_RIGHT_OFFSET_RATIO,
  compositeTimeProjector,
  projectCompositeTimestamp,
  unprojectCompositeTimestamp,
} from "./time-scale";
import { compositeAxisMaxTicks, seriesPriceReference } from "./format";
import type { CompositeTimeScale } from "./types";
import { isFiniteNumber } from "../../../utils/guards";
import { volumeProfile } from "../../../time-series/trader-studies";
import { extendedHoursSpans, isIntradaySeries } from "./session-shading";
import { listingTimeZone } from "../../../market-data/market/trading-sessions";
import { manualValueRangeApplies, valueScaleKey, valueScaleSlot, type CompositeManualValueScale } from "./value-scale";

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveTimeSeriesPointValue(point: TimeSeriesPoint): number | null {
  if (isFiniteNumber(point.value)) return point.value;
  if (isFiniteNumber(point.close)) return point.close;
  return null;
}

/**
 * Heikin Ashi bars in place of a series' own: each close averages the bar's
 * four prices and each open sits halfway along the previous Heikin Ashi body,
 * so the chain runs from the first loaded bar, before any viewport cut. The
 * real close stays in `rawValue` for the last price marker.
 */
export function heikinAshiPoints(points: readonly TimeSeriesPoint[]): TimeSeriesPoint[] {
  let previous: { open: number; close: number } | null = null;
  // Chain over the bars the chart draws: one per observation, in time order,
  // so a superseded copy of a bar never feeds the next open.
  return sortedUniquePoints(points).map((point) => {
    const close = point.close ?? point.value;
    if (!isFiniteNumber(close)) return point;
    const open = isFiniteNumber(point.open) ? point.open : close;
    const high = isFiniteNumber(point.high) ? point.high : Math.max(open, close);
    const low = isFiniteNumber(point.low) ? point.low : Math.min(open, close);
    const haClose = (open + high + low + close) / 4;
    const haOpen = previous ? (previous.open + previous.close) / 2 : (open + close) / 2;
    previous = { open: haOpen, close: haClose };
    return {
      ...point,
      value: haClose,
      rawValue: close,
      open: haOpen,
      high: Math.max(high, haOpen, haClose),
      low: Math.min(low, haOpen, haClose),
      close: haClose,
    };
  });
}

function pointTime(point: TimeSeriesPoint): number | null {
  const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
  return Number.isFinite(time) ? time : null;
}

function isMarketObservationSeries(series: ResolvedSeries): boolean {
  return series.observationKind === "market" || series.timeBasis?.kind === "market";
}

function pointTimestampForScale(
  series: ResolvedSeries,
  point: TimeSeriesPoint,
  timeScale?: CompositeTimeScale,
): number | null {
  const timestamp = pointTime(point);
  if (timestamp === null) return null;
  return timeScale?.kind === "market" && !isMarketObservationSeries(series)
    ? effectiveTimeSeriesPointTime(point)
    : timestamp;
}

interface NormalizedSourcePoint {
  point: TimeSeriesPoint;
  timestamp: number;
  value: number | null;
}

interface NormalizedPointsCache {
  points: readonly TimeSeriesPoint[];
  pointCount: number;
  last: TimeSeriesPoint | undefined;
  lastTimestamp: number | null;
  lastValue: number | null;
  byPlacement: Map<boolean, NormalizedSourcePoint[]>;
}

// Every scene build normalises each series several times over; a viewport
// change must not re-sort thousands of unchanged points. Live ticks mutate
// the last point in place, so the cache also keys on its time and value.
const normalizedPointsCache = new WeakMap<ResolvedSeries, NormalizedPointsCache>();

/**
 * Points already in time order, one per instant and with no fiscal period,
 * normalise in order: each is its own observation, at its own date. Null for
 * anything else, which goes through the keyed sort.
 */
function orderedSourcePoints(points: readonly TimeSeriesPoint[]): NormalizedSourcePoint[] | null {
  const normalized: NormalizedSourcePoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.periodLabel !== undefined) return null;
    const timestamp = pointTime(point);
    if (timestamp === null || timestamp <= previous) return null;
    previous = timestamp;
    normalized.push({ point, timestamp, value: resolveTimeSeriesPointValue(point) });
  }
  return normalized;
}

function computeNormalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  // Placed at their own dates, points in time order are already normalised;
  // a live chart re-resolves its series on every tick.
  const effectiveTimes = timeScale?.kind === "market" && !isMarketObservationSeries(series);
  const ordered = effectiveTimes ? null : orderedSourcePoints(series.points);
  if (ordered) return ordered;
  const byObservation = new Map<string, NormalizedSourcePoint>();
  for (const point of series.points) {
    const sourceTimestamp = pointTime(point);
    const timestamp = pointTimestampForScale(series, point, timeScale);
    if (sourceTimestamp === null || timestamp === null || !Number.isFinite(timestamp)) continue;
    byObservation.set(timeSeriesObservationKey(point), {
      point,
      timestamp,
      value: resolveTimeSeriesPointValue(point),
    });
  }
  return [...byObservation.values()].sort((left, right) => (
    left.timestamp - right.timestamp
    || left.point.date.getTime() - right.point.date.getTime()
    || left.point.observedAt.getTime() - right.point.observedAt.getTime()
  ));
}

function normalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  const effectiveTimes = timeScale?.kind === "market" && !isMarketObservationSeries(series);
  const last = series.points[series.points.length - 1];
  const lastTimestamp = last ? pointTime(last) : null;
  const lastValue = last ? resolveTimeSeriesPointValue(last) : null;
  let cached = normalizedPointsCache.get(series);
  if (
    !cached
    || cached.points !== series.points
    || cached.pointCount !== series.points.length
    || cached.last !== last
    || cached.lastTimestamp !== lastTimestamp
    || cached.lastValue !== lastValue
  ) {
    cached = {
      points: series.points,
      pointCount: series.points.length,
      last,
      lastTimestamp,
      lastValue,
      byPlacement: new Map(),
    };
    normalizedPointsCache.set(series, cached);
  }
  let normalized = cached.byPlacement.get(effectiveTimes);
  if (!normalized) {
    normalized = computeNormalizedSourcePoints(series, timeScale);
    cached.byPlacement.set(effectiveTimes, normalized);
  }
  return normalized;
}

function hasDrawableValue(series: ResolvedSeries): boolean {
  return normalizedSourcePoints(series).some((entry) => entry.value !== null);
}

/**
 * The sorted union of timestamp lists that are each sorted, as
 * `[...new Set(lists.flat())].sort()` gives it, merged in one pass.
 */
function mergeSortedTimestamps(lists: readonly (readonly number[])[]): number[] {
  let merged: number[] = [];
  for (const list of lists) {
    const next: number[] = [];
    let left = 0;
    let right = 0;
    while (left < merged.length || right < list.length) {
      const fromLeft = right >= list.length || (left < merged.length && merged[left]! <= list[right]!);
      const value = fromLeft ? merged[left++]! : list[right++]!;
      if (next.length === 0 || next[next.length - 1] !== value) next.push(value);
    }
    merged = next;
  }
  return merged;
}

function timestampsOf(points: readonly NormalizedSourcePoint[]): number[] {
  const timestamps = new Array<number>(points.length);
  for (let index = 0; index < points.length; index += 1) timestamps[index] = points[index]!.timestamp;
  return timestamps;
}

function explicitViewport(
  options: BuildCompositeChartSceneOptions,
): { startTime: number; endTime: number } | null {
  const startTime = options.viewport?.start.getTime();
  const endTime = options.viewport?.end.getTime();
  return isFiniteNumber(startTime) && isFiniteNumber(endTime) && startTime <= endTime
    ? { startTime, endTime }
    : null;
}

function scopeSeriesToViewport(
  series: ResolvedSeries,
  startTime: number,
  endTime: number,
  timeScale: CompositeTimeScale,
  clipToViewport: boolean,
): ResolvedSeries | null {
  const points = normalizedSourcePoints(series, timeScale);
  const placement = timeScale.kind === "market" && !isMarketObservationSeries(series)
    ? "next-market-slot" as const
    : "timestamp" as const;
  const project = compositeTimeProjector(timeScale, placement);
  const visible = points.filter(({ timestamp }) => {
    if (timestamp >= startTime && timestamp <= endTime) return true;
    if (clipToViewport) return false;
    const projected = project(timestamp);
    return !!projected && projected.ratio >= 0 && projected.ratio <= 1;
  });
  if (series.interpolation === "step-after" || series.style === "step") {
    const anchor = points.some(({ timestamp }) => timestamp === startTime) ? undefined
      : [...points].reverse().find(({ timestamp }) => timestamp < startTime);
    if (anchor && !visible.includes(anchor)) visible.unshift(anchor);
  }
  return visible.some(({ value }) => value !== null)
    ? { ...series, points: visible.map(({ point }) => point) }
    : null;
}

function panelSpecsForSeries(series: ResolvedSeries[], panels: ChartPanelSpec[]): ChartPanelSpec[] {
  const visiblePanelIds = new Set(series.map((entry) => entry.panelId));
  const ordered = panels.filter((panel) => visiblePanelIds.has(panel.id));
  const knownIds = new Set(ordered.map((panel) => panel.id));
  for (const entry of series) {
    if (knownIds.has(entry.panelId)) continue;
    knownIds.add(entry.panelId);
    ordered.push({ id: entry.panelId });
  }
  return ordered;
}

export function allocateCompositePanelHeights(
  panels: ChartPanelSpec[],
  availableHeight: number,
): Map<string, number> {
  const heights = new Map<string, number>();
  if (panels.length === 0) return heights;

  const totalHeight = Math.max(panels.length, Math.floor(availableHeight));
  const weights = panels.map((panel) => (
    isFiniteNumber(panel.height) && panel.height > 0 ? panel.height : 1
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || panels.length;
  const quotas = weights.map((weight) => (weight / totalWeight) * totalHeight);
  const allocations = quotas.map((quota) => Math.max(1, Math.floor(quota)));
  let allocated = allocations.reduce((sum, value) => sum + value, 0);

  while (allocated < totalHeight) {
    let index = 0;
    for (let candidate = 1; candidate < allocations.length; candidate += 1) {
      if (quotas[candidate]! - allocations[candidate]!
        > quotas[index]! - allocations[index]!) {
        index = candidate;
      }
    }
    allocations[index] = (allocations[index] ?? 0) + 1;
    allocated += 1;
  }
  while (allocated > totalHeight) {
    let index = -1;
    for (let candidate = 0; candidate < allocations.length; candidate += 1) {
      if (allocations[candidate]! <= 1) continue;
      if (index < 0 || allocations[candidate]! - quotas[candidate]!
        > allocations[index]! - quotas[index]!) {
        index = candidate;
      }
    }
    if (index < 0) break;
    allocations[index] = allocations[index]! - 1;
    allocated -= 1;
  }

  panels.forEach((panel, index) => heights.set(panel.id, allocations[index] ?? 1));
  return heights;
}

/**
 * The extremes of a set of values, of all of them and of the positive ones a
 * log axis can show, gathered without keeping the values.
 */
interface DomainExtent {
  count: number;
  min: number;
  max: number;
  positiveCount: number;
  positiveMin: number;
  positiveMax: number;
}

function emptyDomainExtent(): DomainExtent {
  return {
    count: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    positiveCount: 0,
    positiveMin: Number.POSITIVE_INFINITY,
    positiveMax: Number.NEGATIVE_INFINITY,
  };
}

function addDomainValue(extent: DomainExtent, value: number): void {
  extent.count += 1;
  extent.min = Math.min(extent.min, value);
  extent.max = Math.max(extent.max, value);
  if (value > 0) {
    extent.positiveCount += 1;
    extent.positiveMin = Math.min(extent.positiveMin, value);
    extent.positiveMax = Math.max(extent.positiveMax, value);
  }
}

/** Every value a series holds its axis open for: its points, their bar extremes or band, and zero under columns. */
function addSeriesDomainValues(extent: DomainExtent, series: ResolvedSeries): void {
  const ohlc = series.dataShape === "ohlcv";
  const band = !ohlc && series.style === "band";
  for (const point of series.points) {
    const scalar = resolveTimeSeriesPointValue(point);
    if (scalar !== null) addDomainValue(extent, scalar);
    if (ohlc) {
      if (isFiniteNumber(point.open)) addDomainValue(extent, point.open);
      if (isFiniteNumber(point.high)) addDomainValue(extent, point.high);
      if (isFiniteNumber(point.low)) addDomainValue(extent, point.low);
      if (isFiniteNumber(point.close)) addDomainValue(extent, point.close);
    } else if (band) {
      if (isFiniteNumber(point.high)) addDomainValue(extent, point.high);
      if (isFiniteNumber(point.low)) addDomainValue(extent, point.low);
    }
  }
  if (series.style === "columns") addDomainValue(extent, 0);
}

function paddedDomain(extent: DomainExtent, scale: PanelScale): { min: number; max: number } {
  const usable = scale === "log" ? extent.positiveCount : extent.count;
  if (usable === 0) return scale === "log" ? { min: 1, max: 10 } : { min: 0, max: 1 };

  const rawMin = scale === "log" ? extent.positiveMin : extent.min;
  const rawMax = scale === "log" ? extent.positiveMax : extent.max;
  if (rawMin === rawMax) {
    if (scale === "log") {
      return { min: rawMin / 1.1, max: rawMax * 1.1 };
    }
    // All zero, as in a session without reported volume, sits on the floor.
    if (rawMin === 0) return { min: 0, max: 1 };
    const delta = Math.max(Math.abs(rawMin) * 0.08, 1);
    return signBounded(rawMin, rawMax, { min: rawMin - delta, max: rawMax + delta });
  }

  if (scale === "log") {
    const logMin = Math.log(rawMin);
    const logMax = Math.log(rawMax);
    const padding = (logMax - logMin) * 0.06;
    return { min: Math.exp(logMin - padding), max: Math.exp(logMax + padding) };
  }

  const padding = (rawMax - rawMin) * 0.06;
  return signBounded(rawMin, rawMax, { min: rawMin - padding, max: rawMax + padding });
}

/** Headroom never pushes one-signed values across zero: a price or volume
 * axis does not reach below 0. */
function signBounded(rawMin: number, rawMax: number, padded: { min: number; max: number }): { min: number; max: number } {
  return {
    min: rawMin >= 0 ? Math.max(0, padded.min) : padded.min,
    max: rawMax <= 0 ? Math.min(0, padded.max) : padded.max,
  };
}

function axisPriceReferences(axisSeries: ResolvedSeries[]): Record<string, number> {
  const references: Record<string, number> = {};
  for (const entry of axisSeries) {
    const key = entry.priceAssetCategory ?? "";
    if (key in references) continue;
    const value = seriesPriceReference(entry);
    if (value !== undefined) references[key] = value;
  }
  return references;
}

/**
 * A one-day chart's previous close joins the axis when it lies within one
 * session range of the bars, so a quiet session still shows where it opened
 * from; a far gap leaves the bars their full height.
 */
function priorCloseInReach(series: readonly ResolvedSeries[], values: DomainExtent): number[] {
  const reference = series.find((entry) => isFiniteNumber(entry.priorClose) && entry.points.length > 0)?.priorClose;
  if (reference === undefined || values.count === 0) return [];
  const low = values.min;
  const high = values.max;
  const span = high - low;
  return reference >= low - span && reference <= high + span ? [reference] : [];
}

function buildAxisDomain(
  side: CompositeAxisSide,
  series: ResolvedSeries[],
  scale: PanelScale,
  rows: number,
  manualScale?: CompositeManualValueScale,
  referenceLevels?: BuildCompositeChartSceneOptions["referenceLevels"],
): CompositeAxisDomain | undefined {
  const axisSeries = series.filter((entry) => entry.axis === side);
  if (axisSeries.length === 0) return undefined;
  const values = emptyDomainExtent();
  for (const entry of axisSeries) addSeriesDomainValues(values, entry);
  const references = referenceLevels && axisSeries.some((entry) => entry.id === referenceLevels.seriesId)
    ? referenceLevels.items.map((level) => level.value).filter(Number.isFinite)
    : [];
  const extra = [...priorCloseInReach(axisSeries, values), ...references];
  const fitted = paddedDomain(extra.length === 0 ? values : extra.reduce((extent, value) => {
    addDomainValue(extent, value);
    return extent;
  }, { ...values }), scale);
  const scaleKey = valueScaleKey(scale, axisSeries);
  // A range set by hand holds while the axis plots the same series and some
  // of their data is in it; otherwise the axis fits the data again.
  const manual = manualScale && manualScale.key === scaleKey && manualValueRangeApplies(manualScale, fitted, scale)
    ? manualScale
    : null;
  const { min, max } = manual ?? fitted;
  const first = axisSeries[0]!;
  return {
    side,
    min,
    max,
    scale,
    unit: first.unit,
    unitGroup: first.unitGroup,
    priceAssetCategories: [...new Set(axisSeries.flatMap((entry) => entry.priceAssetCategory ? [entry.priceAssetCategory] : []))],
    priceReferences: axisPriceReferences(axisSeries),
    seriesIds: axisSeries.map((entry) => entry.id),
    maxTicks: compositeAxisMaxTicks(rows),
    tickRows: rows,
    ...(first.tickGrid ? { tickGrid: first.tickGrid } : {}),
    scaleKey,
    ...(manual ? { manual: true } : {}),
  };
}

/** A panel laid out at another height keeps as many axis ticks as it can
 * label. Hosts that place labels at exact heights drop the row snapping. */
export function resizeCompositePanel(
  panel: CompositePanelScene,
  height: number,
  snapTicksToRows = true,
): CompositePanelScene {
  const maxTicks = compositeAxisMaxTicks(height);
  const tickRows = snapTicksToRows ? height : undefined;
  const fits = (domain: CompositeAxisDomain) => domain.maxTicks === maxTicks && domain.tickRows === tickRows;
  if (panel.height === height && (["left", "right"] as const).every((side) => !panel.axes[side] || fits(panel.axes[side]!))) {
    return panel;
  }
  const axes: CompositePanelScene["axes"] = {};
  for (const side of ["left", "right"] as const) {
    const domain = panel.axes[side];
    if (domain) axes[side] = fits(domain) ? domain : { ...domain, maxTicks, tickRows };
  }
  return { ...panel, height, axes };
}

export function projectCompositeValue(value: number, domain: CompositeAxisDomain): number | null {
  if (!Number.isFinite(value)) return null;
  if (domain.scale === "log") {
    if (value <= 0 || domain.min <= 0 || domain.max <= 0) return null;
    const span = Math.log(domain.max) - Math.log(domain.min);
    return span === 0 ? 0.5 : 1 - (Math.log(value) - Math.log(domain.min)) / span;
  }
  const span = domain.max - domain.min;
  return span === 0 ? 0.5 : 1 - (value - domain.min) / span;
}

export function unprojectCompositeValue(
  yRatio: number,
  domain: CompositeAxisDomain,
): number | null {
  if (
    !Number.isFinite(yRatio)
    || !Number.isFinite(domain.min)
    || !Number.isFinite(domain.max)
  ) {
    return null;
  }
  const ratio = Math.max(0, Math.min(1, yRatio));
  if (domain.scale === "log") {
    if (domain.min <= 0 || domain.max <= 0) return null;
    return Math.exp(
      Math.log(domain.max)
      + (Math.log(domain.min) - Math.log(domain.max)) * ratio,
    );
  }
  return domain.max + (domain.min - domain.max) * ratio;
}

function projectSeries(
  series: ResolvedSeries,
  domain: CompositeAxisDomain,
  startTime: number,
  /** Where a step series holds its last level to, never past the newest bar. */
  stepEndTime: number,
  timeScale: CompositeTimeScale,
): CompositeProjectedPoint[] {
  const projected: CompositeProjectedPoint[] = [];
  let breakBefore = true;
  const placement = timeScale.kind === "market" && !isMarketObservationSeries(series)
    ? "next-market-slot" as const
    : "timestamp" as const;
  const stepSeries = series.interpolation === "step-after" || series.style === "step";
  const project = compositeTimeProjector(timeScale, placement);
  for (const { point, timestamp, value } of normalizedSourcePoints(series, timeScale)) {
    if (value === null) {
      breakBefore = true;
      continue;
    }
    const yRatio = projectCompositeValue(value, domain);
    if (yRatio === null) {
      breakBefore = true;
      continue;
    }
    const projectedTime = project(timestamp);
    if (!projectedTime) continue;
    const beforeViewportStepAnchor = stepSeries
      && timestamp < startTime
      && projectedTime.ratio < 0;
    if (!beforeViewportStepAnchor && (projectedTime.ratio < 0 || projectedTime.ratio > 1)) {
      continue;
    }
    projected.push({
      point,
      timestamp: beforeViewportStepAnchor ? startTime : timestamp,
      value,
      xRatio: beforeViewportStepAnchor ? 0 : projectedTime.ratio,
      xSlot: beforeViewportStepAnchor ? undefined : projectedTime.xSlot,
      yRatio,
      breakBefore,
    });
    breakBefore = false;
  }
  if (stepSeries && projected.length > 0) {
    const last = projected.at(-1)!;
    const trailingGap = normalizedSourcePoints(series, timeScale).some(({ timestamp, value }) => (
      timestamp > last.timestamp && timestamp <= stepEndTime
      && (value === null || projectCompositeValue(value, domain) === null)
    ));
    // The synthetic tail is a level, not an observation, so it lands on its own
    // timestamp rather than snapping forward to the next trading slot.
    const trailingRatio = projectCompositeTimestamp(timeScale, stepEndTime)?.ratio;
    if (last.timestamp < stepEndTime && !trailingGap && trailingRatio !== undefined) {
      projected.push({
        ...last,
        timestamp: stepEndTime,
        xRatio: Math.min(trailingRatio, 1),
        xSlot: undefined,
        breakBefore: false,
      });
    }
  }
  return projected;
}

/**
 * Unit groups a price can wear, raw or transformed. Volume, oscillators and
 * other derived study outputs are deliberately absent: a level line there
 * would mark a quantity that has no last price to read.
 */
const PRICE_UNIT_GROUPS = /^(?:price|currency|percent|index|log)(?::|$)/;

/**
 * The chart's primary price series: the first exchange-traded price, in
 * authored order. Study outputs are appended after the series they derive
 * from, so an overlay indicator never wins over the price it follows.
 */
function primaryPriceSeries(series: readonly ResolvedSeries[]): ResolvedSeries | null {
  return series.find((entry) => (
    entry.timeBasis?.kind === "market"
    && PRICE_UNIT_GROUPS.test(entry.unitGroup.toLowerCase())
  )) ?? null;
}

function lastCloseOf(points: readonly CompositeProjectedPoint[], heikinAshi = false): number | null {
  const last = points.at(-1);
  if (!last) return null;
  // A Heikin Ashi close is an average; the marker names the price that traded.
  if (heikinAshi && isFiniteNumber(last.point.rawValue)) return last.point.rawValue;
  return isFiniteNumber(last.point.close) ? last.point.close : last.value;
}

/** Marks the newest close of the primary price series on the panel that draws it. */
function attachLastPriceMarker(
  panels: CompositePanelScene[],
  series: readonly ResolvedSeries[],
): void {
  const primary = primaryPriceSeries(series);
  if (!primary) return;
  const panel = panels.find((entry) => entry.id === primary.panelId);
  const projected = panel?.series.find((entry) => entry.source.id === primary.id);
  const domain = panel?.axes[primary.axis];
  if (!panel || !projected || !domain) return;
  // A rejected or missing latest bar cannot make an older close current.
  const latest = normalizedSourcePoints(primary).at(-1);
  if (latest?.point.provenance?.priceHistoryIntegrity || latest?.value === null) return;
  const value = lastCloseOf(projected.points, primary.style === "heikin-ashi");
  if (value === null) return;
  const yRatio = projectCompositeValue(value, domain);
  // An axis scaled by hand can leave the last close off the panel.
  if (yRatio === null || (domain.manual && (yRatio < 0 || yRatio > 1))) return;
  panel.lastPrice = {
    seriesId: primary.id,
    color: primary.color,
    axis: primary.axis,
    value,
    yRatio,
  };
}

/** Marks the previous session's close a one-day chart carries on its price series. */
function attachPriorClose(panels: CompositePanelScene[], series: readonly ResolvedSeries[]): void {
  const entry = series.find((candidate) => isFiniteNumber(candidate.priorClose));
  const panel = entry ? panels.find((candidate) => candidate.id === entry.panelId) : undefined;
  const domain = entry ? panel?.axes[entry.axis] : undefined;
  if (!entry || !panel || !domain || !panel.series.some((candidate) => candidate.source.id === entry.id)) return;
  const yRatio = projectCompositeValue(entry.priorClose!, domain);
  // Off the axis it marks nothing; the axis follows the session's own bars.
  if (yRatio === null || yRatio < 0 || yRatio > 1) return;
  panel.priorClose = { axis: entry.axis, value: entry.priorClose!, yRatio };
}

/**
 * The zone intraday market bars read in: the venue's own clock, as the tape
 * does. Daily and longer bars carry dates, which stay in UTC.
 */
function sceneTimeZone(anchor: ResolvedSeries | undefined, series: readonly ResolvedSeries[]): string | undefined {
  const market = anchor ?? series.find((entry) => entry.observationKind === "market");
  if (!market || !isIntradaySeries(market)) return undefined;
  const zone = market.timeBasis?.timeZone
    ?? (market.listing ? listingTimeZone(market.listing.symbol, market.listing.exchange) : null);
  return zone && zone !== "UTC" ? zone : undefined;
}

/**
 * Profiles a volume-profile study over its bars in view and takes its points
 * off the panel, so it draws as a histogram rather than a line or cursor dots.
 */
function attachVolumeProfile(panel: CompositePanelScene): void {
  const entry = panel.series.find((series) => series.source.profile);
  const domain = entry ? panel.axes[entry.source.axis] : undefined;
  if (!entry || !domain) return;
  const bars = entry.points.flatMap(({ point, value }) => {
    const close = isFiniteNumber(point.close) ? point.close : value;
    const volume = point.volume;
    if (!isFiniteNumber(volume)) return [];
    return [{
      time: point.date.getTime(),
      high: isFiniteNumber(point.high) ? point.high : close,
      low: isFiniteNumber(point.low) ? point.low : close,
      close,
      volume,
    }];
  });
  entry.points = [];
  const profile = volumeProfile(bars, entry.source.profile!.rows);
  const pocRatio = profile ? projectCompositeValue(profile.poc, domain) : null;
  if (!profile || pocRatio === null) return;
  panel.volumeProfile = {
    seriesId: entry.source.id,
    color: entry.source.color,
    rows: profile.rows.flatMap((row) => {
      const lowRatio = projectCompositeValue(row.low, domain);
      const highRatio = projectCompositeValue(row.high, domain);
      return lowRatio === null || highRatio === null
        ? []
        : [{ lowRatio, highRatio, volume: row.volume, valueArea: row.valueArea }];
    }),
    maxVolume: profile.maxVolume,
    poc: profile.poc,
    pocRatio,
  };
}

function nearestDate(dates: Date[], requested: Date): Date | null {
  const target = requested.getTime();
  if (!Number.isFinite(target) || dates.length === 0) return null;
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dates[middle]!.getTime() < target) low = middle + 1;
    else high = middle;
  }
  const next = dates[low] ?? null;
  const previous = dates[low - 1] ?? null;
  if (!previous) return next;
  if (!next) return previous;
  return target - previous.getTime() <= next.getTime() - target ? previous : next;
}

function cursorPointForSeries(
  series: CompositePanelScene["series"][number],
  cursorTime: number,
): CompositeProjectedPoint | null {
  const points = series.points;
  if (points.length === 0) return null;

  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle]!.timestamp <= cursorTime) low = middle + 1;
    else high = middle;
  }
  return points[low - 1] ?? null;
}

/**
 * The latest unavailable observation at or before the cursor and after the
 * value it reads there, which ends that value. Points are in time order, so
 * the search stops at the first one older than that value.
 */
function gapAfterCursorValue(
  points: readonly NormalizedSourcePoint[],
  cursorTime: number,
  projected: CompositeProjectedPoint | null,
): NormalizedSourcePoint | undefined {
  const after = projected?.timestamp ?? Number.NEGATIVE_INFINITY;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const entry = points[index]!;
    const { timestamp, point, value } = entry;
    if (timestamp < after) return undefined;
    if (timestamp > cursorTime) continue;
    const later = timestamp > after || (timestamp === projected?.timestamp && point.observedAt > projected.point.observedAt);
    if (later && (point.provenance?.priceHistoryIntegrity || value === null)) return entry;
  }
  return undefined;
}

function buildCursorValues(
  panels: CompositePanelScene[],
  cursorDate: Date | null,
  viewport: Pick<CompositeChartScene, "startTime" | "endTime" | "timeScale">,
): CompositeCursorValue[] {
  const cursorTime = cursorDate?.getTime() ?? viewport.endTime;
  return panels.flatMap((panel) => panel.series.map((entry) => {
    // A profile reads the same wherever the cursor is: its point of control.
    if (entry.source.profile) {
      return {
        seriesId: entry.source.id,
        label: entry.source.label,
        color: entry.source.color,
        unit: entry.source.unit,
        value: panel.volumeProfile?.seriesId === entry.source.id ? panel.volumeProfile.poc : null,
        point: null,
      };
    }
    let projected = cursorPointForSeries(entry, cursorTime);
    // Sparse observations can carry forward, but an explicitly unavailable
    // observation ends that value at its date, including the idle legend.
    const gap = gapAfterCursorValue(normalizedSourcePoints(entry.source, viewport.timeScale), cursorTime, projected);
    if (gap) projected = null;
    // The drawn navigation buffer can include observations after the chosen
    // end. An unarmed legend describes the active window, including when the
    // pointer leaves; explicitly inspected cursor dates keep their own behavior.
    if (!cursorDate && projected && projected.timestamp < viewport.startTime) projected = null;
    return {
      seriesId: entry.source.id,
      label: entry.source.label,
      color: entry.source.color,
      unit: entry.source.unit,
      value: projected?.value ?? null,
      point: projected?.point ?? gap?.point ?? null,
      ...(cursorDate && projected && projected.timestamp < cursorTime ? { carried: true } : {}),
    };
  }));
}

/**
 * The bar a time from another chart lands on: the last one at or before it,
 * as a bar stands for the time from its open until the next. A time before
 * the first bar in view lands on none, and so does one past the plot's right
 * edge while the chart is panned back from its newest bar, rather than
 * pinning the cursor to an edge the time is not at. A chart showing its
 * newest bar lands any later time on it, so a monthly series still reads its
 * latest month on a day after it.
 */
function linkedCursorDate(scene: CompositeChartScene, requested: Date): Date | null {
  const target = requested.getTime();
  const { dates, timeScale } = scene;
  if (!Number.isFinite(target) || dates.length === 0) return null;
  const plotEnd = unprojectCompositeTimestamp(timeScale, 1);
  const newest = timeScale.kind === "market" ? timeScale.anchors.at(-1)?.timestamp : scene.newestTime;
  if (target > plotEnd && (newest === undefined || newest > plotEnd)) return null;
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dates[middle]!.getTime() <= target) low = middle + 1;
    else high = middle;
  }
  return dates[low - 1] ?? null;
}

/** The bar another chart's cursor time lands on (see `linkedCursorDate`), as its timestamp. */
export function compositeLinkedCursorTime(scene: CompositeChartScene, time: number): number | null {
  return linkedCursorDate(scene, new Date(time))?.getTime() ?? null;
}

/**
 * The last instant of the bar a cursor is on, which is the time it is shared
 * at: a bar stands until the next one or its own interval ends, whichever is
 * first. Another chart then lands on its last bar at or before it, so a daily
 * cursor shows the day's last intraday bar, whose close is the day's, and an
 * intraday cursor shows its own day's bar rather than the next one's. On
 * calendar time the newest bar, with no next one, stands as long as the one
 * before it did, so a series' latest month lands a daily chart on that
 * month's latest day rather than its first.
 */
export function compositeCursorAsOf(scene: CompositeChartScene, date: Date): number {
  const start = date.getTime();
  const next = scene.dates.find((entry) => entry.getTime() > start)?.getTime() ?? Number.POSITIVE_INFINITY;
  const previous = scene.dates.findLast((entry) => entry.getTime() < start)?.getTime();
  const intervalEnd = scene.timeScale.kind === "market" ? start + scene.timeScale.cadenceMs
    : next === Number.POSITIVE_INFINITY && previous !== undefined ? start + (start - previous)
      : Number.POSITIVE_INFINITY;
  const end = Math.min(next, intervalEnd);
  return Number.isFinite(end) ? end - 1 : start;
}

/**
 * Applies cursor-only state without rebuilding panel domains or projected
 * series. Keeping those references stable lets renderers reuse the expensive
 * base chart while the cursor moves. `linked` places a time another chart's
 * cursor is at (see `linkedCursorDate`); otherwise the cursor goes to the
 * nearest bar.
 */
export function applyCompositeChartCursor(
  scene: CompositeChartScene,
  requestedCursor: Date | null,
  snap: "nearest" | "linked" = "nearest",
): CompositeChartScene {
  const cursorDate = !requestedCursor ? null
    : snap === "linked" ? linkedCursorDate(scene, requestedCursor)
      : nearestDate(scene.dates, requestedCursor);
  const currentTimestamp = scene.cursorDate?.getTime() ?? null;
  const nextTimestamp = cursorDate?.getTime() ?? null;
  if (currentTimestamp === nextTimestamp) return scene;

  const cursorXRatio = cursorDate
    ? projectCompositeTimestamp(scene.timeScale, cursorDate.getTime())?.ratio ?? null
    : null;
  return {
    ...scene,
    cursorDate,
    cursorXRatio,
    cursorValues: buildCursorValues(scene.cursorPanels ?? scene.panels, cursorDate, scene),
  };
}

export function buildCompositeChartScene(
  series: ResolvedSeries[],
  panels: ChartPanelSpec[],
  options: BuildCompositeChartSceneOptions,
): CompositeChartScene | null {
  const dataSeries = series
    .map((entry) => entry.style === "heikin-ashi" ? { ...entry, points: heikinAshiPoints(entry.points) } : entry)
    .filter(hasDrawableValue);
  if (dataSeries.length === 0) return null;

  // A known missing observation owns a date even though it has no drawable
  // value. Retain it in the window and cursor timeline, including trailing gaps.
  const uniqueTimes = mergeSortedTimestamps(dataSeries.map((entry) => timestampsOf(normalizedSourcePoints(entry))));
  if (uniqueTimes.length === 0) return null;
  const firstTime = uniqueTimes[0]!;
  const lastTime = uniqueTimes.at(-1)!;
  const viewport = explicitViewport(options);
  const startTime = viewport?.startTime ?? (firstTime === lastTime ? firstTime - DAY_MS / 2 : firstTime);
  const endTime = viewport?.endTime ?? (firstTime === lastTime ? lastTime + DAY_MS / 2 : lastTime);
  const timelineSeries = options.timelineSeries?.some((entry) => (
    entry.timeBasis?.kind === "market" && entry.points.length > 0
  )) ? options.timelineSeries : dataSeries;
  const timeScale = buildCompositeTimeScale(
    timelineSeries,
    startTime,
    endTime,
    options.rightOffsetRatio ?? COMPOSITE_RIGHT_OFFSET_RATIO,
  );
  // The plot reaches past the viewport by the reserved right offset. Panned
  // back into history that space holds real observations, so navigation and
  // the cursor follow the drawn edge rather than the viewport end.
  const plotEndTime = options.clipToViewport ? endTime : Math.max(endTime, unprojectCompositeTimestamp(timeScale, 1));
  // A step holds its level to the newest observation and no further: the space
  // reserved after it stays empty. With data still ahead of the window, the
  // level runs to the drawn edge instead.
  const stepTrailingTime = Math.min(plotEndTime, Math.max(lastTime, endTime));
  const scopedSeries = viewport
    ? dataSeries.flatMap((entry) => scopeSeriesToViewport(entry, startTime, endTime, timeScale, options.clipToViewport === true) ?? [])
    : dataSeries;
  // A range without observations still has a chart: keep the panels, axes and
  // grid and simply draw no points, instead of blanking the whole surface.
  const emptyRange = scopedSeries.length === 0;
  const usableSeries = emptyRange
    ? dataSeries.map((entry) => ({ ...entry, points: [] }))
    : scopedSeries;
  const visibleTimes = uniqueTimes.filter((time) => time >= startTime && time <= plotEndTime);
  const marketTimes = timeScale.kind === "market"
    // The first market controls session spacing, but every plotted market
    // observation must remain inspectable. Other exchanges can trade before
    // or after its anchors. Nonmarket source dates stay excluded: filings
    // retain their availability-based placement on eligible market slots.
    ? mergeSortedTimestamps([
      timeScale.anchors.map(({ timestamp }) => timestamp),
      ...scopedSeries.filter(isMarketObservationSeries)
        .map((entry) => timestampsOf(normalizedSourcePoints(entry)
          .filter(({ value, point }) => value !== null || point.provenance?.priceHistoryIntegrity))),
    ]).filter((time) => time >= startTime && time <= plotEndTime)
    : [];
  const cursorTimes = timeScale.kind === "market" ? marketTimes : visibleTimes;
  const dates = (cursorTimes.length > 0
    ? cursorTimes
    : viewport
      ? [...new Set([startTime, endTime])]
      : uniqueTimes
  ).map((time) => new Date(time));
  const projectDate = compositeTimeProjector(timeScale);
  const dateRatios = dates.map((date) => projectDate(date.getTime())?.ratio ?? 0);
  const requestedCursor = options.cursorDate ?? null;
  const cursorDate = requestedCursor ? nearestDate(dates, requestedCursor) : null;
  const cursorXRatio = cursorDate
    ? projectCompositeTimestamp(timeScale, cursorDate.getTime())?.ratio ?? null
    : null;
  // Panels belong to the authored series, not to whichever of them happen to
  // hold observations right now. A panel that disappears while its data loads
  // reflows every other panel, and the chart jumps again when it comes back.
  const anchor = timeScale.kind === "market"
    ? timelineSeries.find((entry) => entry.id === timeScale.anchorSeriesId)
    : timelineSeries.find((entry) => entry.timeBasis?.kind === "market");
  const extendedHours = extendedHoursSpans(anchor, dates, dateRatios);
  const orderedPanels = panelSpecsForSeries(series, panels);
  const panelHeights = allocateCompositePanelHeights(orderedPanels, options.height);

  const panelScenes: CompositePanelScene[] = orderedPanels.map((panel) => {
    const panelSeries = usableSeries.filter((entry) => entry.panelId === panel.id);
    const scale = panel.scale ?? "linear";
    // With no in-view values, scale the axes to the loaded history rather than
    // the meaningless 0..1 fallback, so the panel keeps its gutter and grid.
    const domainSeries = emptyRange || panelSeries.length === 0
      ? dataSeries.filter((entry) => entry.panelId === panel.id)
      : panelSeries;
    const rows = panelHeights.get(panel.id) ?? 1;
    const left = buildAxisDomain("left", domainSeries, scale, rows, options.valueScales?.[valueScaleSlot(panel.id, "left")], options.referenceLevels);
    const right = buildAxisDomain("right", domainSeries, scale, rows, options.valueScales?.[valueScaleSlot(panel.id, "right")], options.referenceLevels);
    const axes: Partial<Record<CompositeAxisSide, CompositeAxisDomain>> = { left, right };
    return {
      id: panel.id,
      label: panel.label,
      height: panelHeights.get(panel.id) ?? 1,
      scale,
      axes,
      ...(extendedHours.length > 0 ? { extendedHours } : {}),
      series: panelSeries.flatMap((entry) => {
        const domain = axes[entry.axis];
        return domain
          ? [{
            source: entry,
            points: projectSeries(entry, domain, startTime, stepTrailingTime, timeScale),
          }]
          : [];
      }),
    };
  });
  panelScenes.forEach(attachVolumeProfile);
  attachLastPriceMarker(panelScenes, usableSeries);
  attachPriorClose(panelScenes, usableSeries);
  const timeZone = sceneTimeZone(anchor, timelineSeries);

  return {
    width: Math.max(1, Math.floor(options.width)),
    height: panelScenes.reduce((sum, panel) => sum + panel.height, 0),
    startTime,
    endTime,
    timeScale,
    dates,
    dateRatios,
    panels: panelScenes,
    cursorDate,
    cursorXRatio,
    cursorValues: buildCursorValues(panelScenes, cursorDate, { startTime, endTime, timeScale }),
    newestTime: lastTime,
    ...(timeZone ? { timeZone } : {}),
  };
}

export function resolveCompositeCursorDate(scene: CompositeChartScene, localX: number): Date | null {
  if (scene.dates.length === 0) return null;
  const ratio = scene.width <= 1
    ? 0
    : Math.max(0, Math.min(1, localX / Math.max(scene.width - 1, 1)));
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  scene.dateRatios.forEach((candidate, index) => {
    const distance = Math.abs(candidate - ratio);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  });
  return scene.dates[nearestIndex] ?? null;
}

export function resolveAdjacentCompositeCursorDate(
  scene: CompositeChartScene,
  current: Date | null,
  step: -1 | 1,
): Date | null {
  if (scene.dates.length === 0) return null;
  if (!current || !Number.isFinite(current.getTime())) {
    return step < 0 ? scene.dates.at(-1) ?? null : scene.dates[0] ?? null;
  }

  const currentTime = current.getTime();
  let currentIndex = scene.dates.findIndex((date) => date.getTime() === currentTime);
  if (currentIndex < 0) {
    const snapped = nearestDate(scene.dates, current);
    currentIndex = snapped
      ? scene.dates.findIndex((date) => date.getTime() === snapped.getTime())
      : 0;
  }
  const nextIndex = Math.max(0, Math.min(scene.dates.length - 1, currentIndex + step));
  return scene.dates[nextIndex] ?? null;
}
