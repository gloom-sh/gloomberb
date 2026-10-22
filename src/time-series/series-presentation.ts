import { limitSeriesObservations } from "./financial-period-coverage";
import type { ManualChartResolution } from "./resolution";
import { getTimeSeriesField } from "./field-catalog";
import { collectPriceHistoryIntegrity } from "./market";
import { activeStudyInputSeriesIds } from "./studies";
import { applyResolvedSeriesTransform } from "./transforms";
import { clipSeriesToWindow } from "./alignment";
import {
  comparedBufferPoints,
  priceComparisonBoundsForSeries,
  priceObservationWindowFilter,
  type PriceComparison,
} from "./price-comparison";
import { parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";
import type {
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
} from "./types";
import { type DateBounds, filterPoints } from "./chart-bounds";

export function resolvePriceHistoryIntegrity(
  spec: ChartSpec,
  requestedSeries: readonly ResolvedSeries[],
  visibleSeries: readonly ResolvedSeries[],
  bounds: DateBounds,
  resolution: ManualChartResolution | "auto",
  dateWindow: ChartSpec["viewport"]["dateWindow"] | null,
) {
  const filters = new Map(requestedSeries.map((entry) => [entry.id, priceObservationWindowFilter(entry, bounds, resolution, dateWindow)]));
  const requestedIds = activeStudyInputSeriesIds(spec.studies);
  spec.series.filter((entry) => entry.visible !== false).forEach((entry) => requestedIds.add(entry.id));
  const selected = requestedSeries.filter((entry) => requestedIds.has(entry.id)).map((entry) => limitSeriesObservations(spec, {
    ...entry, points: entry.points.filter((point) => filters.get(entry.id)!(point.date.getTime())),
  }));
  return [
    ...collectPriceHistoryIntegrity(selected, "requested-observation", (id, time) => filters.get(id)!(time)),
    ...collectPriceHistoryIntegrity(visibleSeries, "visible-calculation"),
  ];
}

export function assignAxes(
  series: ResolvedSeries[],
  specs: readonly { id: string; axis: ChartSeriesSpec["axis"] }[],
  warnings: string[],
): ResolvedSeries[] {
  const requested = new Map(specs.map((spec) => [spec.id, spec.axis] as const));
  const groupsByPanel = new Map<string, Partial<Record<"left" | "right", string>>>();
  return series.map((entry) => {
    const groups = groupsByPanel.get(entry.panelId) ?? {};
    groupsByPanel.set(entry.panelId, groups);
    const preferred = requested.get(entry.id);
    let axis: "left" | "right";
    if (preferred === "left" || preferred === "right") {
      axis = preferred;
    } else if (groups.left === entry.unitGroup) {
      axis = "left";
    } else if (groups.right === entry.unitGroup) {
      axis = "right";
    } else if (!groups.left) {
      axis = "left";
    } else {
      axis = "right";
    }
    if (groups[axis] && groups[axis] !== entry.unitGroup) {
      warnings.push(`${entry.label} shares the ${axis} axis with a different unit; choose an explicit panel for independent scaling.`);
    }
    groups[axis] ??= entry.unitGroup;
    return { ...entry, axis };
  });
}

/**
 * A series drawn in a ticker's price (a moving average of it, a band around
 * it) takes the units of that ticker's price series when the chart has it, so
 * the two share an axis and the line sits on the price instead of on a scale
 * of its own.
 */
export function adoptPriceUnits(series: ResolvedSeries[], specs: readonly ChartSeriesSpec[]): ResolvedSeries[] {
  if (!series.some((entry) => entry.priceOf)) return series;
  const specsById = new Map(specs.map((spec) => [spec.id, spec]));
  const prices = series.filter((entry) => {
    const source = specsById.get(entry.id)?.source;
    return source?.kind === "security" && getTimeSeriesField(source.fieldId)?.unitGroup === "price"
      && entry.transform === "raw";
  });
  if (prices.length === 0) return series;
  return series.map((entry) => {
    if (!entry.priceOf) return entry;
    const wanted = parsePublicTickerKey(entry.priceOf.toUpperCase());
    const key = publicTickerKey(wanted.symbol, wanted.exchange);
    const named = (price: ResolvedSeries) => {
      const source = specsById.get(price.id)?.source;
      if (source?.kind !== "security") return false;
      return publicTickerKey(source.instrument.symbol, source.instrument.exchange) === key
        || (!wanted.exchange && source.instrument.symbol.toUpperCase() === wanted.symbol);
    };
    const price = prices.find((candidate) => named(candidate) && candidate.panelId === entry.panelId)
      ?? prices.find(named);
    return price && entry.transform === "raw"
      ? { ...entry, unit: price.unit, unitGroup: price.unitGroup }
      : entry;
  });
}

export function prepareBaseSeriesForStudies(
  series: ResolvedSeries,
  bounds: DateBounds,
  clipToBounds = false,
  fallbackBaselineBounds?: DateBounds,
): ResolvedSeries {
  const baselineTransform = series.transform === "percent" || series.transform === "index100";
  let source = series;
  if (clipToBounds && bounds.start !== null && bounds.end !== null) {
    source = clipSeriesToWindow(series, new Date(bounds.start), new Date(bounds.end));
  } else if (clipToBounds) {
    source = { ...series, points: filterPoints(series.points, bounds) };
  }
  const baseline = baselineTransform
    ? scalarBaseline(series, bounds)
      ?? (fallbackBaselineBounds ? scalarBaseline(series, fallbackBaselineBounds) : null)
    : null;
  return applyResolvedSeriesTransform(
    source,
    source.transform,
    baselineTransform ? { baseline } : undefined,
  );
}

function scalarBaseline(series: ResolvedSeries, bounds: DateBounds): number | null {
  const points = filterPoints(series.points, bounds);
  for (const point of points) {
    const value = typeof point.value === "number" && Number.isFinite(point.value)
      ? point.value
      : typeof point.close === "number" && Number.isFinite(point.close)
        ? point.close
        : null;
    if (value !== null && value !== 0) return value;
  }
  return null;
}

function studyForOutput(
  outputId: string,
  studies: readonly ChartSpec["studies"][number][],
): ChartSpec["studies"][number] | undefined {
  return studies
    .filter((study) => outputId === study.id || outputId.startsWith(`${study.id}:`))
    .sort((left, right) => right.id.length - left.id.length)[0];
}

/** Price overlays read in the price's own terms, so they take its transform. */
function followsInputTransform(kind: ChartSpec["studies"][number]["kind"]): boolean {
  return kind === "sma" || kind === "ema" || kind === "bollinger" || kind === "vwap" || kind === "anchored-vwap";
}

export function presentationBounds(
  series: ResolvedSeries,
  studies: readonly ChartSpec["studies"][number][],
  comparison: PriceComparison | null,
  fallback: DateBounds,
): DateBounds {
  const study = studyForOutput(series.id, studies);
  const sourceId = study && followsInputTransform(study.kind)
    ? study.inputSeriesIds[0] : series.id;
  return (sourceId && comparison?.sourceBounds?.[sourceId]) || fallback;
}

export function applyStudyPresentationTransforms(
  outputs: ResolvedSeries[],
  studies: readonly ChartSpec["studies"][number][],
  rawSeries: readonly ResolvedSeries[],
  visibleBounds: DateBounds,
  fallbackBaselineBounds?: DateBounds,
  priceComparison?: PriceComparison | null,
  view: DateBounds = visibleBounds,
): ResolvedSeries[] {
  const rawById = new Map(rawSeries.map((series) => [series.id, series] as const));
  return outputs.map((output) => {
    const study = studyForOutput(output.id, studies);
    if (!study || !followsInputTransform(study.kind)) {
      return output;
    }
    const input = rawById.get(study.inputSeriesIds[0] ?? "");
    if (!input || input.transform === "raw") return output;
    const baseline = input.transform === "percent" || input.transform === "index100"
      ? scalarBaseline(input, priceComparisonBoundsForSeries(input, priceComparison ?? null) ?? visibleBounds)
        ?? (fallbackBaselineBounds ? scalarBaseline(input, fallbackBaselineBounds) : null)
      : undefined;
    const transformed = applyResolvedSeriesTransform(output, input.transform, { baseline });
    const inputBounds = priceComparison?.sourceBounds?.[input.id];
    return inputBounds ? { ...transformed, points: comparedBufferPoints(transformed.points, inputBounds, view) } : transformed;
  });
}
