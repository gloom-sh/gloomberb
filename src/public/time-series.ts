/**
 * Chart range and resolution vocabulary (`gloomberb/time-series`).
 *
 * Shared so a plugin producing history speaks the same range and resolution
 * language as the charts that render it, instead of inventing a parallel one.
 */
// The names are listed rather than re-exported with `*` because this list is
// the public surface: a new export in these modules stays internal until it is
// added here.
export {
  CHART_RESOLUTIONS, TIME_RANGES,
} from "../time-series/range";
export type {
  ChartBarSizeUnit, ChartDateWindow, ChartResolution, CustomChartResolution, TimeRange,
} from "../time-series/range";
export {
  CHART_RESOLUTION_STEP_MS, chartBarSizeSource, chartBarSizeStepMs, clampTimeRangeToMaxRange,
  DEFAULT_CHART_RESOLUTION_SUPPORT, getBestSupportedResolutionForVisibleWindow, getChartResolutionLabel,
  getExpandedBufferRange, getNextBufferRange, getPresetResolution, getSupportedChartResolutionsForViewport,
  getSupportedPresetResolution, getSupportMaxRange, intersectChartResolutionSupport, isChartResolution,
  isIntradayResolution, isManualChartResolution, isRangePresetSupported, normalizeChartResolution,
  normalizeChartResolutionSupport, parseChartBarSize, sortChartResolutions, TIME_RANGE_ORDER,
} from "../time-series/resolution";
export type {
  ChartBarSize, ChartResolutionSupport, ManualChartResolution,
} from "../time-series/resolution";
// Bars of a size the source does not serve, built from its shorter ones the way the chart builds them.
export { aggregatePriceBars } from "../time-series/bar-aggregation";
export type { AggregatedPricePoint, BarAggregationListing } from "../time-series/bar-aggregation";

// The resolved shape itself: what a chart-series capability returns and what
// the composite chart draws. A plugin that answers `chartSeriesProvider`
// builds one of these.
export {
  CHART_SPEC_VERSION,
} from "../time-series/types";
export type {
  CapabilitySeriesSource, ChartPanelSpec, ChartResolutionResult, ChartSeriesPriceHistoryIntegrity,
  ChartSeriesSource, ChartSeriesSpec, ChartSpec, ChartStudyKind, ChartStudySpec, ChartViewportSpec,
  EconomicSeriesSource, PanelScale, ResolvedSeries, ResolvedSeriesMarketTimeBasis,
  SecuritySeriesSource, SeriesAxis, SeriesDataShape, SeriesInterpolation, SeriesPeriod, SeriesStyle,
  SeriesTimestampMode, SeriesTransform, TimeSeriesFieldDefinition, TimeSeriesPoint,
} from "../time-series/types";

// Series a plugin adds to the data catalog, chartable against any other
// catalog entry: `series` on the plugin, or `ctx.registerSeries` from setup.
// PLUGINS.md ("Data catalog series") shows both, and series from a file.
export {
  defineSeries, describeSeriesUnits, isValidSeriesUnit, SERIES_FREQUENCIES, validateSeriesDefinition,
} from "../series/validate";
export {
  inferSeriesFrequency, parseSeriesCsv,
} from "../series/csv";
export type {
  ParsedSeriesCsv, SeriesCsvColumn, SeriesCsvMetadata,
} from "../series/csv";
export type {
  ExpressionSeriesDefinition, LoadedSeriesDefinition, SeriesDefinition, SeriesDrawStyle, SeriesFrequency,
  SeriesAttribution, SeriesInput, SeriesLine, SeriesLinesLoadResult, SeriesLoadOutput, SeriesLoadRequest, SeriesLoadResult, SeriesPlacement,
  SeriesPoint,
} from "../series/types";
