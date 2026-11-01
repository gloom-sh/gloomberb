import type { HeadlessPaneOptionValues } from "../../../types/headless";
import {
  TIME_RANGES,
  type ChartResolution,
  type TimeRange,
} from "../../../time-series/range";
import { parseChartResolution } from "../../../time-series/resolution";
import {
  coerceSeriesTransformForStyle,
  normalizeChartSpec,
} from "../../../time-series/spec";
import type { ChartSeriesSpec, ChartSpec, SeriesPeriod } from "../../../time-series/types";
import { yearToDateBaseDay } from "../../../market-data/market/year-to-date";
import { readPriceWindow } from "../../../utils/price-window";

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

/** The shortest range whose history reaches back to `from`: 5Y for a window from 2022, ALL for one from 2019. */
function rangeCovering(from: string, now = Date.now()): TimeRange {
  const days = (now - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  const covering: Array<[TimeRange, number]> = [["1M", 31], ["3M", 92], ["6M", 183], ["1Y", 366], ["5Y", 5 * 366]];
  return covering.find(([, span]) => days <= span)?.[0] ?? "ALL";
}

function chartResolution(options: HeadlessPaneOptionValues): ChartResolution | null {
  return parseChartResolution(options.chartResolution ?? options.resolution);
}

function financialPeriod(value: unknown, valuation: boolean): SeriesPeriod | null {
  return value === "annual" || value === "quarterly" || value === "ttm" || (valuation && value === "daily") ? value : null;
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

  // --from and --to: those dates, each leg rebased at its first close in them, as YTD is from the prior year's last.
  const window = capabilityId === "price-comparison"
    ? readPriceWindow(typeof options.from === "string" ? options.from : undefined, typeof options.to === "string" ? options.to : undefined)
    : null;
  if (window) {
    next = { ...next, viewport: { ...next.viewport, range: rangeCovering(window.from), dateWindow: { start: window.from, end: window.to } } };
  }

  if (capabilityId === "price-chart" && options.extendedHours === true) {
    next = { ...next, viewport: { ...next.viewport, extendedHours: true } };
  }

  if (capabilityId === "price-comparison" && options.totalReturn === true) {
    next = { ...next, viewport: { ...next.viewport, totalReturn: true } };
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
  if (graphKind) {
    const period = financialPeriod(options.period, graphKind === "valuation");
    next = {
      ...next,
      series: mapSecuritySeries(next.series, (entry) => ({
        ...entry,
        source: entry.source.kind === "security" ? {
          ...entry.source,
          ...(typeof options.metric === "string" ? { fieldId: `${graphKind}.${options.metric}` } : {}),
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
