import type {
  ResolvedSeries,
  ResolvedSeriesMarketTimeBasis,
  SeriesPeriod,
  SeriesStyle,
  SeriesTransform,
  TimeSeriesPoint,
} from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";

export interface PricePointsToResolvedSeriesOptions {
  id: string;
  label: string;
  color: string;
  unit: string;
  unitGroup?: string;
  nativeFrequency?: SeriesPeriod;
  style?: SeriesStyle;
  transform?: SeriesTransform;
  axis?: ResolvedSeries["axis"];
  panelId?: string;
  providerId?: string;
  warning?: string;
  timeBasis?: ResolvedSeriesMarketTimeBasis;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePricePoint(point: PricePoint, providerId?: string): TimeSeriesPoint | null {
  const date = point.date instanceof Date ? new Date(point.date) : new Date(point.date as unknown as string | number);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    date,
    observedAt: date,
    value: finiteOrNull(point.close),
    open: finiteOrNull(point.open),
    high: finiteOrNull(point.high),
    low: finiteOrNull(point.low),
    close: finiteOrNull(point.close),
    volume: finiteOrNull(point.volume),
    provenance: providerId ? { providerId, quality: "reported" } : undefined,
  };
}

/** Converts the app's canonical price history into the generic chart-series boundary. */
export function pricePointsToResolvedSeries(
  points: readonly PricePoint[],
  options: PricePointsToResolvedSeriesOptions,
): ResolvedSeries {
  const byTimestamp = new Map<number, TimeSeriesPoint>();
  for (const point of points) {
    const normalized = normalizePricePoint(point, options.providerId);
    if (!normalized) continue;
    byTimestamp.set(normalized.date.getTime(), normalized);
  }

  return {
    id: options.id,
    label: options.label,
    color: options.color,
    unit: options.unit,
    unitGroup: options.unitGroup ?? "currency",
    nativeFrequency: options.nativeFrequency ?? "daily",
    dataShape: "ohlcv",
    style: options.style ?? "area",
    transform: options.transform ?? "raw",
    axis: options.axis ?? "left",
    panelId: options.panelId ?? "main",
    interpolation: "none",
    timeBasis: options.timeBasis,
    points: [...byTimestamp.values()].sort((left, right) => left.date.getTime() - right.date.getTime()),
    warning: options.warning,
  };
}
