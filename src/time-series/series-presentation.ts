import { limitSeriesObservations } from "./financial-period-coverage";
import type { ManualChartResolution } from "./resolution";
import { getTimeSeriesField } from "./field-catalog";
import { collectPriceHistoryIntegrity } from "./market";
import { activeStudyInputSeriesIds } from "./studies/resolve";
import { applyResolvedSeriesTransform } from "./transforms";
import { clipSeriesToWindow } from "./alignment";
import type { StudyAnchor } from "./leverage";
import {
  comparedBufferPoints,
  priceComparisonBoundsForSeries,
  priceObservationWindowFilter,
  type PriceComparison,
} from "./price-comparison";
import { parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";
import { physicalQuantity } from "./price-units";
import { isCurrencyCode } from "../utils/currency-pair";
import type {
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
} from "./types";
import { type DateBounds, filterPoints } from "./chart-bounds";
import { isFormulaNextMonth } from "./formula-months";

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
  // A formula's hidden next month is no series the chart was asked for.
  for (const id of requestedIds) if (isFormulaNextMonth(id)) requestedIds.delete(id);
  const selected = requestedSeries.filter((entry) => requestedIds.has(entry.id)).map((entry) => limitSeriesObservations(spec, {
    ...entry, points: entry.points.filter((point) => filters.get(entry.id)!(point.date.getTime())),
  }));
  return [
    ...collectPriceHistoryIntegrity(selected, "requested-observation", (id, time) => filters.get(id)!(time)),
    ...collectPriceHistoryIntegrity(visibleSeries, "visible-calculation"),
  ];
}

/**
 * What sets a price's scale beyond its currency: the physical quantity it
 * counts ("gallon" for USD / gallon, "barrel" for USD/bbl), or "currency" for
 * an FX rate (USD / EUR). Null for a bare currency, a share or a unit, which
 * scale as any price in their currency does.
 */
function scaleQuantity(unit: string): string | null {
  const slash = unit.indexOf("/");
  if (slash < 0) return null;
  const per = unit.slice(slash + 1).trim();
  return physicalQuantity(per) ?? (/^[A-Z]{3}$/.test(per) && isCurrencyCode(per) ? "currency" : null);
}

/** A price under this share of another's in the same unit is drawn against an axis of its own. */
const SHARED_AXIS_LEVEL_SHARE = 0.1;

/** The largest size a series' values reach, or null without one. */
function seriesLevel(entry: ResolvedSeries): number | null {
  let level: number | null = null;
  for (const point of entry.points) {
    const value = typeof point.value === "number" ? point.value : typeof point.close === "number" ? point.close : null;
    if (value !== null && Number.isFinite(value)) level = Math.max(level ?? 0, Math.abs(value));
  }
  return level !== null && level > 0 ? level : null;
}

/** A security's own price as charted, not a study of it or a transform: what can take an axis of its own. */
function isOwnPrice(entry: ResolvedSeries): boolean {
  return !!entry.listing && !entry.priceOf && entry.transform === "raw" && entry.unitGroup.startsWith("price:");
}

/** Whether a series drawn in a ticker's price (`priceOf`, a moving average of it) is in `price`'s. */
function drawnInPriceOf(entry: ResolvedSeries, price: ResolvedSeries): boolean {
  if (!entry.priceOf || !price.listing) return false;
  const wanted = parsePublicTickerKey(entry.priceOf.toUpperCase());
  return publicTickerKey(price.listing.symbol, price.listing.exchange) === publicTickerKey(wanted.symbol, wanted.exchange)
    || (!wanted.exchange && price.listing.symbol.toUpperCase() === wanted.symbol);
}

/**
 * Prices in one unit whose sizes are an order apart, sharing the left axis of
 * a panel with nothing on its right: those under SHARED_AXIS_LEVEL_SHARE of
 * the largest move to the right axis, with what is drawn in their price, so
 * each reads on a scale of its own. Silver at $52 beside gold at $4,050 drew
 * as a flat line on gold's $0-$4K axis. Series a spec placed stay.
 */
function splitDistantPrices(series: ResolvedSeries[], requested: ReadonlyMap<string, ChartSeriesSpec["axis"]>): ResolvedSeries[] {
  const placed = (entry: ResolvedSeries) => requested.get(entry.id) === "left" || requested.get(entry.id) === "right";
  const moved = new Set<string>();
  for (const panelId of new Set(series.map((entry) => entry.panelId))) {
    const panel = series.filter((entry) => entry.panelId === panelId);
    if (panel.some((entry) => entry.axis === "right")) continue;
    const prices = panel.filter((entry) => entry.axis === "left" && !placed(entry) && isOwnPrice(entry));
    const unitGroup = prices[0]?.unitGroup;
    const levels = new Map(prices.filter((entry) => entry.unitGroup === unitGroup).flatMap((entry) => {
      const level = seriesLevel(entry);
      return level === null ? [] : [[entry, level] as const];
    }));
    const largest = Math.max(0, ...levels.values());
    const small = [...levels].filter(([, level]) => level < largest * SHARED_AXIS_LEVEL_SHARE).map(([entry]) => entry);
    if (small.length === 0 || small.length === levels.size) continue;
    for (const entry of panel) {
      if (small.includes(entry) || (!placed(entry) && small.some((price) => drawnInPriceOf(entry, price)))) moved.add(entry.id);
    }
  }
  return moved.size === 0 ? series : series.map((entry) => moved.has(entry.id) ? { ...entry, axis: "right" } : entry);
}

/**
 * Each series' axis: one a spec names, else the side whose series count the
 * same unit. Prices in one currency per different physical quantities
 * (heating oil USD / gallon beside Brent USD / barrel), or a price beside an
 * FX rate, scale on axes of their own; per-share and per-unit prices, and FX
 * rates quoted in one currency, share one as any prices in that currency do,
 * unless one is under a tenth of another's size (splitDistantPrices).
 */
export function assignAxes(
  series: ResolvedSeries[],
  specs: readonly { id: string; axis: ChartSeriesSpec["axis"] }[],
  warnings: string[],
): ResolvedSeries[] {
  type AxisUnit = { group: string; quantity: string | null };
  const requested = new Map(specs.map((spec) => [spec.id, spec.axis] as const));
  const groupsByPanel = new Map<string, Partial<Record<"left" | "right", AxisUnit>>>();
  const assigned: ResolvedSeries[] = series.map((entry) => {
    const groups = groupsByPanel.get(entry.panelId) ?? {};
    groupsByPanel.set(entry.panelId, groups);
    const quantity = scaleQuantity(entry.unit);
    const sameGroup = (side: "left" | "right") => groups[side]?.group === entry.unitGroup;
    const fits = (side: "left" | "right") => {
      const held = groups[side];
      return sameGroup(side) && (!held!.quantity || !quantity || held!.quantity === quantity);
    };
    const preferred = requested.get(entry.id);
    let axis: "left" | "right";
    if (preferred === "left" || preferred === "right") {
      axis = preferred;
    } else if (fits("left")) {
      axis = "left";
    } else if (fits("right")) {
      axis = "right";
    } else if (!groups.left) {
      axis = "left";
    } else if (!groups.right || !sameGroup("left")) {
      axis = "right";
    } else {
      // Both axes taken: a third quantity in the same currency shares as it would without them.
      axis = "left";
    }
    const held = groups[axis];
    if (held && held.group !== entry.unitGroup) {
      warnings.push(`${entry.label} shares the ${axis} axis with a different unit; choose an explicit panel for independent scaling.`);
    }
    if (!held) groups[axis] = { group: entry.unitGroup, quantity };
    else if (!held.quantity && quantity && fits(axis)) held.quantity = quantity;
    return { ...entry, axis };
  });
  return splitDistantPrices(assigned, requested);
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

/**
 * Where studies that read returns over the chart's period measure each series
 * from and to: a compared leg's shared first and last session, else the
 * window in view.
 */
export function studyAnchors(
  series: readonly ResolvedSeries[],
  comparison: PriceComparison | null,
  bounds: DateBounds,
): Map<string, StudyAnchor> {
  return new Map(series.map((entry) => [entry.id, priceComparisonBoundsForSeries(entry, comparison) ?? bounds]));
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
