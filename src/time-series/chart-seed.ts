import { limitSeriesObservations } from "./financial-period-coverage";
import {
  chartBarSizeSource,
  intersectChartResolutionSupport,
  isCustomChartResolution,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "./resolution";
import { aggregatePriceBars, futuresOpenMinuteOf, withBuiltBarSize } from "./bar-aggregation";
import type { TickerFinancials } from "../types/financials";
import { isMarketFieldId } from "./field-catalog";
import { chartPriceHistoryIntegrityNotices } from "./market";
import { resolveStudies } from "./studies/resolve";
import { clipSeriesToWindow } from "./alignment";
import { bufferPriceComparison, clipPriceComparison, priceComparisonBoundsForSeries, resolvePriceComparison } from "./price-comparison";
import { readSeedListingFacts } from "./parsed-history-cache";
import { getPricePointTimestamp } from "../utils/price-history";
import type {
  ChartResolutionResult,
  ChartSpec,
  ResolvedSeries,
} from "./types";
import { type ChartResolveOptions, instrumentKey } from "./resolve-context";
import {
  explicitBounds,
  requestedBounds,
  runtimeRequestBounds,
  requestResolution,
  filterPoints,
  comparisonDisplayBounds,
  followLatestMarketObservation,
  latestSessionView,
} from "./chart-bounds";
import { emptyFinancials, chartCalculationSeriesIds, baseSecuritySeries } from "./base-series";
import {
  resolvePriceHistoryIntegrity,
  assignAxes,
  prepareBaseSeriesForStudies,
  presentationBounds,
  applyStudyPresentationTransforms,
  studyAnchors,
} from "./series-presentation";

/** Select the provisional seed cadence before provider resolution support arrives. */
function seedOpenMinute(spec: ChartSpec): number | null {
  return futuresOpenMinuteOf(spec.series.flatMap((entry) => (
    entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId) ? [entry.source.instrument] : []
  )));
}

export function chartSeedResolution(spec: ChartSpec, now: Date, options: ChartResolveOptions = {}): ManualChartResolution {
  return requestResolution(spec, requestedBounds(spec, now), chartCalculationSeriesIds(spec), options, [], false, seedOpenMinute(spec));
}

export function seedChartResolutionResult(
  spec: ChartSpec,
  historyByInstrument: ReadonlyMap<string, TickerFinancials["priceHistory"]>,
  referenceNow?: Date,
  options: ChartResolveOptions = {},
): ChartResolutionResult | null {
  let latest = Number.NEGATIVE_INFINITY;
  for (const history of historyByInstrument.values()) {
    for (const point of history) latest = Math.max(latest, getPricePointTimestamp(point));
  }
  if (!Number.isFinite(latest)) return null;
  const now = referenceNow ?? new Date(latest);
  const resolution = chartSeedResolution(spec, now, options);
  // A size the source does not serve is built from its bars, as the settled chart builds it.
  const builtBarSize = isCustomChartResolution(spec.viewport.resolution)
    && resolution === chartBarSizeSource(spec.viewport.resolution, [], seedOpenMinute(spec)) ? spec.viewport.resolution : null;
  // The seed is replaced by the settled chart moments later. Draw it with
  // what that chart will know (units, served cadence, where its axis ends) so
  // the swap changes no label and moves no plot.
  const support: ChartResolutionSupport[][] = [];
  const series: ResolvedSeries[] = [];
  spec.series.forEach((seriesSpec, index) => {
    if (seriesSpec.visible === false || seriesSpec.source.kind !== "security") return;
    if (!isMarketFieldId(seriesSpec.source.fieldId)) return;
    const history = historyByInstrument.get(instrumentKey(seriesSpec.source));
    if (!history?.length) return;
    const facts = readSeedListingFacts(seriesSpec.source.instrument);
    const { symbol, exchange } = seriesSpec.source.instrument;
    const bars = builtBarSize ? aggregatePriceBars(history, builtBarSize, { symbol, exchange }) : history;
    const base = baseSecuritySeries(seriesSpec, emptyFinancials(bars), index, resolution, facts?.quoteMetadata, facts?.contractUnit);
    const resolved = base && builtBarSize ? withBuiltBarSize(base, builtBarSize) : base;
    if (!resolved?.points.length) return;
    series.push(resolved);
    if (facts?.resolutionSupport?.length) support.push(facts.resolutionSupport);
  });
  if (series.length === 0) return null;
  const requested = requestedBounds(spec, now);
  const sessionView = spec.viewport.range === "1D" && !explicitBounds(spec)
    ? latestSessionView(series[0], series, spec.viewport.extendedHours === true, undefined)
    : null;
  const bounds = explicitBounds(spec) || runtimeRequestBounds(options)
    ? requested
    : sessionView?.bounds ?? followLatestMarketObservation(requested, series);
  const primary = series[0]!;
  if (sessionView?.priorClose != null && primary.transform === "raw"
    && primary.unitGroup.startsWith("price") && primary.unitGroup !== "price:unknown") {
    series[0] = { ...primary, priorClose: sessionView.priorClose };
  }
  const resolutionSupport = support.length === series.length ? intersectChartResolutionSupport(support) : [];
  const priceComparison = resolvePriceComparison(spec, series, bounds, resolution, spec.viewport.dateWindow,
    { preset: explicitBounds(spec) || runtimeRequestBounds(options) ? null : spec.viewport.range, now: referenceNow?.getTime() ?? Date.now() });
  const displayBounds = comparisonDisplayBounds(bounds, priceComparison);
  const comparisonBounds = priceComparison && priceComparison.start !== null
    ? priceComparison : bounds;
  const baseSeries = series.map((entry) => prepareBaseSeriesForStudies(entry, priceComparisonBoundsForSeries(entry, priceComparison) ?? comparisonBounds));
  // Calculate studies from raw buffered inputs, then use the same presentation
  // and visible-window rules as the network result.
  const studies = resolveStudies(series, spec.studies, resolution, undefined, studyAnchors(series, priceComparison, comparisonBounds));
  const axisWarnings: string[] = [];
  const bufferedSeries = assignAxes([
    ...baseSeries,
    ...applyStudyPresentationTransforms(studies.series, spec.studies, series, comparisonBounds, undefined, priceComparison, bounds),
  ], [...spec.series, ...spec.studies], axisWarnings).map((entry) => bufferPriceComparison(entry, priceComparison, bounds));
  const visible = bufferedSeries.map((entry) => {
    const entryBounds = presentationBounds(entry, spec.studies, priceComparison, bounds);
    const clipped = entryBounds.start !== null && entryBounds.end !== null
      ? clipSeriesToWindow(entry, new Date(entryBounds.start), new Date(entryBounds.end))
      : { ...entry, points: filterPoints(entry.points, entryBounds) };
    return clipPriceComparison(limitSeriesObservations(spec, clipped), priceComparison);
  });
  const priceHistoryIntegrity = resolvePriceHistoryIntegrity(spec, series, visible, bounds, resolution, spec.viewport.dateWindow ?? null);
  return {
    series: visible,
    ...(priceHistoryIntegrity.length ? { priceHistoryIntegrity } : {}),
    ...(priceComparison ? { priceComparison } : {}),
    ...(resolutionSupport.length > 0 ? { resolutionSupport } : {}),
    legendSeries: visible,
    ...(spec.viewport.maxPoints === undefined ? { bufferedSeries } : {}),
    ...((explicitBounds(spec) !== null || spec.viewport.maxPoints === undefined)
      && displayBounds.start !== null && displayBounds.end !== null
      ? { viewport: { start: new Date(displayBounds.start), end: new Date(displayBounds.end) } } : {}),
    loading: true,
    errors: studies.errors,
    warnings: [...studies.warnings, ...axisWarnings, ...chartPriceHistoryIntegrityNotices(priceHistoryIntegrity), ...(priceComparison ? [priceComparison.notice] : [])],
    resolution,
    ...(builtBarSize ? { barSize: builtBarSize } : {}),
  };
}
