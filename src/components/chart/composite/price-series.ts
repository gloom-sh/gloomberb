import type {
  ResolvedSeries,
  ResolvedSeriesMarketTimeBasis,
  SeriesPeriod,
  SeriesStyle,
  SeriesTransform,
  TimeSeriesPoint,
} from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";
import { pricePointValues, priceHistoryIntegrityNotice } from "../../../utils/price-history-integrity";

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

// A chart re-resolves its series on every quote tick to append one live
// point; the history points behind it never change identity, so their
// resolved form is kept per point and provider.
const resolvedPoints = new WeakMap<PricePoint, { providerId: string | undefined; resolved: TimeSeriesPoint | null }>();

function normalizePricePoint(point: PricePoint, providerId?: string): TimeSeriesPoint | null {
  const cached = resolvedPoints.get(point);
  if (cached && cached.providerId === providerId) return cached.resolved;
  const resolved = normalizePricePointUncached(point, providerId);
  resolvedPoints.set(point, { providerId, resolved });
  return resolved;
}

function normalizePricePointUncached(point: PricePoint, providerId?: string): TimeSeriesPoint | null {
  const date = point.date instanceof Date ? new Date(point.date) : new Date(point.date as unknown as string | number);
  if (!Number.isFinite(date.getTime())) return null;
  const { integrity, ...values } = pricePointValues(point);
  return {
    date,
    observedAt: date,
    value: values.close,
    ...values,
    provenance: providerId || integrity ? { providerId, quality: "reported", ...(integrity ? { priceHistoryIntegrity: integrity } : {}) } : undefined,
  };
}

/** The points one per instant in time order, the later of two at one instant kept. */
function uniqueTimeOrderedPoints(points: readonly PricePoint[], providerId: string | undefined): TimeSeriesPoint[] {
  // A history comes in time order: kept as it is, it needs no keyed sort.
  const ordered: TimeSeriesPoint[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const normalized = normalizePricePoint(point, providerId);
    if (!normalized) continue;
    const time = normalized.date.getTime();
    if (time <= previous) return keyedTimeOrderedPoints(points, providerId);
    previous = time;
    ordered.push(normalized);
  }
  return ordered;
}

function keyedTimeOrderedPoints(points: readonly PricePoint[], providerId: string | undefined): TimeSeriesPoint[] {
  const byTimestamp = new Map<number, TimeSeriesPoint>();
  for (const point of points) {
    const normalized = normalizePricePoint(point, providerId);
    if (!normalized) continue;
    byTimestamp.set(normalized.date.getTime(), normalized);
  }
  return [...byTimestamp.values()].sort((left, right) => left.date.getTime() - right.date.getTime());
}

/** Converts the app's canonical price history into the generic chart-series boundary. */
export function pricePointsToResolvedSeries(
  points: readonly PricePoint[],
  options: PricePointsToResolvedSeriesOptions,
): ResolvedSeries {
  const resolved = uniqueTimeOrderedPoints(points, options.providerId);
  let rejected = 0;
  for (const point of resolved) if (point.provenance?.priceHistoryIntegrity) rejected += 1;

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
    points: resolved,
    warning: [options.warning, priceHistoryIntegrityNotice(rejected)].filter(Boolean).join(" ") || undefined,
  };
}
