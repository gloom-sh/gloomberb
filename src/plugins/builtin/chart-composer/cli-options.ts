import type { NormalizedPaneFunctionOptions } from "../../../cli/pane-functions/capabilities";
import {
  CHART_RESOLUTIONS,
  TIME_RANGES,
  type ChartResolution,
  type TimeRange,
} from "../../../time-series/range";
import {
  coerceSeriesTransformForStyle,
  normalizeChartSpec,
} from "../../../time-series/spec";
import type { ChartSeriesSpec, ChartSpec, SeriesPeriod } from "../../../time-series/types";

const PRICE_CAPABILITIES = new Set(["price-chart", "intraday-price-chart", "price-comparison"]);

function chartRange(options: NormalizedPaneFunctionOptions): TimeRange | null {
  const value = options.rangePreset ?? options.range;
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value)
    ? value as TimeRange
    : null;
}

function chartResolution(options: NormalizedPaneFunctionOptions): ChartResolution | null {
  const value = options.chartResolution ?? options.resolution;
  return typeof value === "string" && (CHART_RESOLUTIONS as readonly string[]).includes(value)
    ? value as ChartResolution
    : null;
}

function financialPeriod(value: unknown): SeriesPeriod | null {
  return value === "annual" || value === "quarterly" || value === "ttm" ? value : null;
}

function mapSecuritySeries(
  series: readonly ChartSeriesSpec[],
  update: (entry: ChartSeriesSpec) => ChartSeriesSpec,
): ChartSeriesSpec[] {
  return series.map((entry) => entry.source.kind === "security" ? update(entry) : entry);
}

/** Applies normalized CLI options directly to the single persisted chart spec. */
export function applyChartComposerCapabilityOptions(
  spec: ChartSpec,
  capabilityId: string,
  options: NormalizedPaneFunctionOptions,
): ChartSpec {
  let next = spec;
  const range = chartRange(options);
  const resolution = chartResolution(options);
  if (range || resolution) {
    next = {
      ...next,
      viewport: {
        ...next.viewport,
        ...(range ? { range, dateWindow: undefined } : {}),
        ...(resolution ? { resolution } : {}),
      },
    };
  }

  if (PRICE_CAPABILITIES.has(capabilityId) && options.axisMode) {
    const transform = options.axisMode === "percent" ? "percent" : "raw";
    next = {
      ...next,
      series: mapSecuritySeries(next.series, (entry) => ({
        ...entry,
        transform: coerceSeriesTransformForStyle(entry.style, transform),
      })),
    };
  }

  const graphKind = capabilityId === "fundamental-series"
    ? "fundamental"
    : capabilityId === "valuation-series" ? "valuation" : null;
  if (graphKind && typeof options.metric === "string") {
    const period = financialPeriod(options.period);
    next = {
      ...next,
      series: mapSecuritySeries(next.series, (entry) => ({
        ...entry,
        source: entry.source.kind === "security" ? {
          ...entry.source,
          fieldId: `${graphKind}.${options.metric}`,
          ...(period ? { period } : {}),
        } : entry.source,
      })),
    };
  }

  if (graphKind && typeof options.periods === "number" && Number.isFinite(options.periods)) {
    next = {
      ...next,
      viewport: {
        ...next.viewport,
        maxPoints: Math.max(1, Math.min(40, Math.floor(options.periods))),
      },
    };
  }

  return normalizeChartSpec(next, spec);
}
