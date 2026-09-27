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
  ChartDateWindow, ChartResolution, TimeRange,
} from "../time-series/range";
export {
  CHART_RESOLUTION_STEP_MS, clampTimeRangeToMaxRange, DEFAULT_CHART_RESOLUTION_SUPPORT,
  getBestSupportedResolutionForVisibleWindow, getChartResolutionLabel, getExpandedBufferRange,
  getNextBufferRange, getPresetResolution, getSupportedChartResolutionsForViewport,
  getSupportedPresetResolution, getSupportMaxRange, intersectChartResolutionSupport,
  isIntradayResolution, isRangePresetSupported, normalizeChartResolution,
  normalizeChartResolutionSupport, sortChartResolutions, TIME_RANGE_ORDER,
} from "../time-series/resolution";
export type {
  ChartResolutionSupport, ManualChartResolution,
} from "../time-series/resolution";

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
