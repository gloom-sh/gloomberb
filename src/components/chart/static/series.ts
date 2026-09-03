import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Static charts read left to right by observation, not by wall clock: a yield
 * curve's tenors, a Kelly curve's fractions, and a sparse economic release are
 * all indices in disguise. Declaring a one-day market cadence gives every
 * observation one slot on the composite time scale, matching the legacy
 * index-spaced renderer, while real dates still label the axis.
 */
const INDEX_SPACED_TIME_BASIS: NonNullable<ResolvedSeries["timeBasis"]> = {
  kind: "market",
  timeZone: "UTC",
  cadenceMs: DAY_MS,
};

export interface StaticSeriesOptions {
  id: string;
  label?: string;
  color: string;
  style?: ResolvedSeries["style"];
  dataShape?: ResolvedSeries["dataShape"];
  /** Wall-clock spacing instead of one slot per observation. */
  calendarSpaced?: boolean;
}

export function staticSeries(points: TimeSeriesPoint[], options: StaticSeriesOptions): ResolvedSeries {
  return {
    id: options.id,
    label: options.label ?? options.id,
    color: options.color,
    unit: "",
    unitGroup: "",
    nativeFrequency: "daily",
    dataShape: options.dataShape ?? "scalar",
    style: options.style ?? "line",
    transform: "raw",
    axis: "right",
    panelId: "main",
    interpolation: "none",
    ...(options.calendarSpaced ? {} : { timeBasis: INDEX_SPACED_TIME_BASIS }),
    points,
  };
}

export function scalarPoint(date: Date, value: number | null): TimeSeriesPoint {
  return { date, observedAt: date, value };
}
