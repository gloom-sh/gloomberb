/**
 * Chart range and resolution vocabulary (`gloomberb/time-series`).
 *
 * Shared so a plugin producing history speaks the same range and resolution
 * language as the charts that render it, instead of inventing a parallel one.
 */
export * from "../time-series/range";
export * from "../time-series/resolution";

// The resolved shape itself: what a chart-series capability returns and what
// the composite chart draws. A plugin that answers `chartSeriesProvider`
// builds one of these.
export * from "../time-series/types";
