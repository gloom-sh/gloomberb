import type {
  ChartPanelSpec,
  PanelScale,
  ResolvedSeries,
  TimeSeriesPoint,
} from "../../../time-series/types";
import { effectiveTimeSeriesPointTime } from "../../../time-series/alignment";
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
  projectCompositeTimestamp,
} from "./time-scale";
import type { CompositeTimeScale } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function resolveTimeSeriesPointValue(point: TimeSeriesPoint): number | null {
  if (finiteNumber(point.value)) return point.value;
  if (finiteNumber(point.close)) return point.close;
  return null;
}

function pointTime(point: TimeSeriesPoint): number | null {
  const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
  return Number.isFinite(time) ? time : null;
}

function pointTimestampForScale(
  series: ResolvedSeries,
  point: TimeSeriesPoint,
  timeScale?: CompositeTimeScale,
): number | null {
  const timestamp = pointTime(point);
  if (timestamp === null) return null;
  return timeScale?.kind === "market" && !series.timeBasis
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

function computeNormalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  const bySourceTimestamp = new Map<number, NormalizedSourcePoint>();
  for (const point of series.points) {
    const sourceTimestamp = pointTime(point);
    const timestamp = pointTimestampForScale(series, point, timeScale);
    if (sourceTimestamp === null || timestamp === null || !Number.isFinite(timestamp)) continue;
    bySourceTimestamp.set(sourceTimestamp, {
      point,
      timestamp,
      value: resolveTimeSeriesPointValue(point),
    });
  }
  return [...bySourceTimestamp.values()].sort((left, right) => (
    left.timestamp - right.timestamp
    || left.point.date.getTime() - right.point.date.getTime()
  ));
}

function normalizedSourcePoints(
  series: ResolvedSeries,
  timeScale?: CompositeTimeScale,
): NormalizedSourcePoint[] {
  const effectiveTimes = timeScale?.kind === "market" && !series.timeBasis;
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

function normalizedPoints(series: ResolvedSeries): Array<{
  point: TimeSeriesPoint;
  timestamp: number;
  value: number;
}> {
  return normalizedSourcePoints(series).flatMap((entry) => (
    entry.value === null
      ? []
      : [{ ...entry, value: entry.value }]
  ));
}

function explicitViewport(
  options: BuildCompositeChartSceneOptions,
): { startTime: number; endTime: number } | null {
  const startTime = options.viewport?.start.getTime();
  const endTime = options.viewport?.end.getTime();
  return finiteNumber(startTime) && finiteNumber(endTime) && startTime <= endTime
    ? { startTime, endTime }
    : null;
}

function scopeSeriesToViewport(
  series: ResolvedSeries,
  startTime: number,
  endTime: number,
  timeScale: CompositeTimeScale,
): ResolvedSeries | null {
  const points = normalizedSourcePoints(series, timeScale);
  const placement = timeScale.kind === "market" && !series.timeBasis
    ? "next-market-slot" as const
    : "timestamp" as const;
  const visible = points.filter(({ timestamp }) => {
    if (timestamp >= startTime && timestamp <= endTime) return true;
    const projected = projectCompositeTimestamp(timeScale, timestamp, placement);
    return !!projected && projected.ratio >= 0 && projected.ratio <= 1;
  });
  if (series.interpolation === "step-after" || series.style === "step") {
    const anchor = [...points].reverse().find(({ timestamp, value }) => timestamp < startTime && value !== null);
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
    finiteNumber(panel.height) && panel.height > 0 ? panel.height : 1
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

function seriesDomainValues(series: ResolvedSeries): number[] {
  const values: number[] = [];
  for (const point of series.points) {
    const scalar = resolveTimeSeriesPointValue(point);
    if (scalar !== null) values.push(scalar);
    if (series.dataShape === "ohlcv") {
      for (const candidate of [point.open, point.high, point.low, point.close]) {
        if (finiteNumber(candidate)) values.push(candidate);
      }
    }
  }
  if (series.style === "columns") values.push(0);
  return values;
}

function paddedDomain(values: number[], scale: PanelScale): { min: number; max: number } {
  const usable = scale === "log" ? values.filter((value) => value > 0) : values;
  if (usable.length === 0) return scale === "log" ? { min: 1, max: 10 } : { min: 0, max: 1 };

  const rawMin = Math.min(...usable);
  const rawMax = Math.max(...usable);
  if (rawMin === rawMax) {
    if (scale === "log") {
      return { min: rawMin / 1.1, max: rawMax * 1.1 };
    }
    const delta = Math.max(Math.abs(rawMin) * 0.08, 1);
    return { min: rawMin - delta, max: rawMax + delta };
  }

  if (scale === "log") {
    const logMin = Math.log(rawMin);
    const logMax = Math.log(rawMax);
    const padding = (logMax - logMin) * 0.06;
    return { min: Math.exp(logMin - padding), max: Math.exp(logMax + padding) };
  }

  const padding = (rawMax - rawMin) * 0.06;
  if (rawMin === 0 && rawMax > 0) {
    return { min: 0, max: rawMax + padding };
  }
  if (rawMax === 0 && rawMin < 0) {
    return { min: rawMin - padding, max: 0 };
  }
  return { min: rawMin - padding, max: rawMax + padding };
}

function buildAxisDomain(
  side: CompositeAxisSide,
  series: ResolvedSeries[],
  scale: PanelScale,
): CompositeAxisDomain | undefined {
  const axisSeries = series.filter((entry) => entry.axis === side);
  if (axisSeries.length === 0) return undefined;
  const { min, max } = paddedDomain(axisSeries.flatMap(seriesDomainValues), scale);
  const first = axisSeries[0]!;
  return {
    side,
    min,
    max,
    scale,
    unit: first.unit,
    unitGroup: first.unitGroup,
    seriesIds: axisSeries.map((entry) => entry.id),
  };
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
  endTime: number,
  timeScale: CompositeTimeScale,
): CompositeProjectedPoint[] {
  const projected: CompositeProjectedPoint[] = [];
  let breakBefore = true;
  const placement = timeScale.kind === "market" && !series.timeBasis
    ? "next-market-slot" as const
    : "timestamp" as const;
  const stepSeries = series.interpolation === "step-after" || series.style === "step";
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
    const projectedTime = projectCompositeTimestamp(timeScale, timestamp, placement);
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
      timestamp > last.timestamp && timestamp <= endTime
      && (value === null || projectCompositeValue(value, domain) === null)
    ));
    if (last.timestamp < endTime && !trailingGap) {
      projected.push({ ...last, timestamp: endTime, xRatio: 1, breakBefore: false });
    }
  }
  return projected;
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
  cursorTime: number | null,
): CompositeProjectedPoint | null {
  const points = series.points;
  if (points.length === 0) return null;
  if (cursorTime === null) return points.at(-1) ?? null;

  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (points[middle]!.timestamp <= cursorTime) low = middle + 1;
    else high = middle;
  }
  return points[low - 1] ?? null;
}

function buildCursorValues(
  panels: CompositePanelScene[],
  cursorDate: Date | null,
): CompositeCursorValue[] {
  const cursorTime = cursorDate?.getTime() ?? null;
  return panels.flatMap((panel) => panel.series.map((entry) => {
    const projected = cursorPointForSeries(entry, cursorTime);
    return {
      seriesId: entry.source.id,
      label: entry.source.label,
      color: entry.source.color,
      unit: entry.source.unit,
      value: projected?.value ?? null,
      point: projected?.point ?? null,
    };
  }));
}

/**
 * Applies cursor-only state without rebuilding panel domains or projected
 * series. Keeping those references stable lets renderers reuse the expensive
 * base chart while the cursor moves.
 */
export function applyCompositeChartCursor(
  scene: CompositeChartScene,
  requestedCursor: Date | null,
): CompositeChartScene {
  const cursorDate = requestedCursor ? nearestDate(scene.dates, requestedCursor) : null;
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
    cursorValues: buildCursorValues(scene.panels, cursorDate),
  };
}

export function buildCompositeChartScene(
  series: ResolvedSeries[],
  panels: ChartPanelSpec[],
  options: BuildCompositeChartSceneOptions,
): CompositeChartScene | null {
  const dataSeries = series.filter((entry) => normalizedPoints(entry).length > 0);
  if (dataSeries.length === 0) return null;

  const times = dataSeries.flatMap((entry) => normalizedPoints(entry).map((point) => point.timestamp));
  const uniqueTimes = [...new Set(times)].sort((left, right) => left - right);
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
  );
  const scopedSeries = viewport
    ? dataSeries.flatMap((entry) => scopeSeriesToViewport(entry, startTime, endTime, timeScale) ?? [])
    : dataSeries;
  // A range without observations still has a chart: keep the panels, axes and
  // grid and simply draw no points, instead of blanking the whole surface.
  const emptyRange = scopedSeries.length === 0;
  const usableSeries = emptyRange
    ? dataSeries.map((entry) => ({ ...entry, points: [] }))
    : scopedSeries;
  const visibleTimes = uniqueTimes.filter((time) => time >= startTime && time <= endTime);
  const marketTimes = timeScale.kind === "market"
    ? timeScale.anchors
      .map(({ timestamp }) => timestamp)
      .filter((time) => time >= startTime && time <= endTime)
    : [];
  const cursorTimes = timeScale.kind === "market" ? marketTimes : visibleTimes;
  const dates = (cursorTimes.length > 0
    ? cursorTimes
    : viewport
      ? [...new Set([startTime, endTime])]
      : uniqueTimes
  ).map((time) => new Date(time));
  const dateRatios = dates.map((date) => (
    projectCompositeTimestamp(timeScale, date.getTime())?.ratio ?? 0
  ));
  const requestedCursor = options.cursorDate ?? null;
  const cursorDate = requestedCursor ? nearestDate(dates, requestedCursor) : null;
  const cursorXRatio = cursorDate
    ? projectCompositeTimestamp(timeScale, cursorDate.getTime())?.ratio ?? null
    : null;
  // Panels belong to the authored series, not to whichever of them happen to
  // hold observations right now. A panel that disappears while its data loads
  // reflows every other panel, and the chart jumps again when it comes back.
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
    const left = buildAxisDomain("left", domainSeries, scale);
    const right = buildAxisDomain("right", domainSeries, scale);
    const axes: Partial<Record<CompositeAxisSide, CompositeAxisDomain>> = { left, right };
    return {
      id: panel.id,
      label: panel.label,
      height: panelHeights.get(panel.id) ?? 1,
      scale,
      axes,
      series: panelSeries.flatMap((entry) => {
        const domain = axes[entry.axis];
        return domain
          ? [{ source: entry, points: projectSeries(entry, domain, startTime, endTime, timeScale) }]
          : [];
      }),
    };
  });

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
    cursorValues: buildCursorValues(panelScenes, cursorDate),
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
