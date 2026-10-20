import type { HeadlessPaneOptionValues } from "../../../types/headless";
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
import { yearToDateBaseDay } from "../../../market-data/market/year-to-date";

const PRICE_CAPABILITIES = new Set(["price-chart", "intraday-price-chart", "price-comparison"]);

function chartRange(options: HeadlessPaneOptionValues): TimeRange | null {
  const value = options.rangePreset ?? options.range;
  return typeof value === "string" && (TIME_RANGES as readonly string[]).includes(value)
    ? value as TimeRange
    : null;
}

/**
 * YTD as a window: from the prior year's last session to today, so a return
 * comparison starts at the close year-to-date returns are measured from (31
 * Dec 2025 for 2026), never at the year's first session. The earliest of the
 * charted listings' last December sessions, a venue's own calendar where it
 * is known.
 */
export function yearToDateWindow(spec: ChartSpec, now = Date.now()): { start: string; end: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  const venues = [...new Set(spec.series.flatMap((entry) => entry.source.kind === "security" ? [entry.source.instrument.exchange || undefined] : []))];
  const starts = (venues.length ? venues : [undefined]).flatMap((venue) => yearToDateBaseDay(today, venue, now) ?? []);
  return { start: starts.sort()[0] ?? `${Number(today.slice(0, 4)) - 1}-12-31`, end: today };
}

function chartResolution(options: HeadlessPaneOptionValues): ChartResolution | null {
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
  options: HeadlessPaneOptionValues,
): ChartSpec {
  let next = spec;
  if ((options.rangePreset ?? options.range) === "YTD") {
    // A year of daily bars, shown from the prior year's last close.
    next = { ...next, viewport: { ...next.viewport, range: "1Y", dateWindow: yearToDateWindow(next) } };
  }
  const selectedRange = chartRange(options);
  const range = capabilityId === "intraday-price-chart" && typeof options.session === "string"
    ? "1D"
    : selectedRange;
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

  if (capabilityId === "price-chart" && options.extendedHours === true) {
    next = { ...next, viewport: { ...next.viewport, extendedHours: true } };
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
        // A period count is not a five-year date window. Preserve authored
        // constraints, otherwise select from all available observations.
        ...(!selectedRange && !next.viewport.dateWindow ? { range: "ALL" as const } : {}),
        maxPoints: Math.max(1, Math.min(40, Math.floor(options.periods))),
      },
    };
  }

  return normalizeChartSpec(next, spec);
}
