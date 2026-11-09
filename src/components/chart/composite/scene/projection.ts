// Projection for the composite chart scene: a value to its place on an axis and
// back, and a series' points to ratios of the plot.
import type { ResolvedSeries } from "../../../../time-series/types";
import type { CompositeAxisDomain, CompositeProjectedPoint, CompositeTimeScale } from "../types";
import { compositeTimeProjector, projectCompositeTimestamp } from "../time-scale";
import { isMarketObservationSeries, normalizedSourcePoints } from "./points";

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

export function projectSeries(
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
