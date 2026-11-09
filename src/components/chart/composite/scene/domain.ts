// Axis domains for the composite chart scene: the extremes of the values an
// axis holds open, their padding, and the finished domain of one axis.
import type { PanelScale, ResolvedSeries } from "../../../../time-series/types";
import type { BuildCompositeChartSceneOptions, CompositeAxisDomain, CompositeAxisSide } from "../types";
import { compositeAxisMaxTicks, seriesPriceReference } from "../format";
import { isFiniteNumber } from "../../../../utils/guards";
import { manualValueRangeApplies, valueScaleKey, type CompositeManualValueScale } from "../value-scale";
import { resolveTimeSeriesPointValue } from "./points";

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

export function buildAxisDomain(
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
