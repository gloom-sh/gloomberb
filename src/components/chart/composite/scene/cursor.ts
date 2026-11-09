// The cursor of a composite chart scene: the bar it sits on, the values it
// reads, linking it to another chart's time, and moving it.
import type {
  CompositeChartScene,
  CompositeCursorValue,
  CompositePanelScene,
  CompositeProjectedPoint,
} from "../types";
import { projectCompositeTimestamp, unprojectCompositeTimestamp } from "../time-scale";
import { normalizedSourcePoints, type NormalizedSourcePoint } from "./points";

export function nearestDate(dates: Date[], requested: Date): Date | null {
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

export function buildCursorValues(
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
