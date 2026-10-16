import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Static charts default to reading left to right by observation. Callers with
 * unequal numeric or calendar gaps opt into calendarSpaced to preserve them.
 * Declaring a one-day market cadence gives every
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
  /**
   * Intraday clock. The axis reads this zone, and each bar keeps this cadence.
   * A session-date change still takes one slot.
   */
  timeZone?: string;
  cadenceMs?: number;
  /** Columns below zero in this colour. */
  negativeColor?: string;
}

function intradayBasis(options: StaticSeriesOptions): { timeBasis?: ResolvedSeries["timeBasis"] } {
  const { timeZone, cadenceMs } = options;
  if (timeZone && timeZone !== "UTC" && typeof cadenceMs === "number" && cadenceMs > 0 && cadenceMs < DAY_MS) {
    return { timeBasis: { kind: "market", timeZone, cadenceMs } };
  }
  return options.calendarSpaced ? {} : { timeBasis: INDEX_SPACED_TIME_BASIS };
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
    ...intradayBasis(options),
    ...(options.negativeColor ? { negativeColor: options.negativeColor } : {}),
    points,
  };
}

export function scalarPoint(date: Date, value: number | null): TimeSeriesPoint {
  return { date, observedAt: date, value };
}
