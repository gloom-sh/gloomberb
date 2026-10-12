import { MAX_CHART_SERIES_POINTS } from "../capabilities/chart-series";
import { subtractTimeRange } from "../time-series/date-window";
import type {
  ChartViewportSpec,
  ResolvedSeries,
  SeriesPeriod,
  TimeSeriesPoint,
} from "../time-series/types";
import { SERIES_COLORS } from "../theme/series-colors";
import type {
  LoadedSeriesDefinition,
  SeriesFrequency,
  SeriesLoadOutput,
  SeriesLoadRequest,
  SeriesPoint,
} from "./types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A point's date, with a bare `YYYY-MM-DD` read as that UTC day. */
function seriesPointDate(value: SeriesPoint["date"]): Date | null {
  const date = typeof value === "string" && DATE_ONLY.test(value.trim())
    ? new Date(`${value.trim()}T00:00:00Z`)
    : value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Oldest first, one point per instant (the last one given wins), at most the chart's point limit. */
export function normalizeSeriesPoints(points: readonly SeriesPoint[]): TimeSeriesPoint[] {
  const byTime = new Map<number, number | null>();
  for (const point of points) {
    const date = point ? seriesPointDate(point.date) : null;
    if (!date) continue;
    const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
    byTime.set(date.getTime(), value);
  }
  const sorted = [...byTime].sort(([left], [right]) => left - right);
  return sorted.slice(-MAX_CHART_SERIES_POINTS).map(([time, value]) => {
    const date = new Date(time);
    return { date, observedAt: date, value };
  });
}

function nativeFrequency(frequency: SeriesFrequency): SeriesPeriod {
  return frequency === "intraday" || frequency === "irregular" ? "auto" : frequency;
}

/** Series in one unit share an axis; percentages share it with FRED's. */
function seriesUnitGroup(unit: string): string {
  return unit === "%" ? "percent" : `series:${unit.toLowerCase()}`;
}

/** One colour per id, so two loaded series on a chart are told apart. */
function seriesColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SERIES_COLORS[hash % SERIES_COLORS.length]!;
}

/** The dates a chart viewport covers, as a series load request takes them. */
export function seriesLoadWindow(viewport: ChartViewportSpec, now = new Date()): Pick<SeriesLoadRequest, "start" | "end"> {
  if (viewport.dateWindow) {
    const start = new Date(viewport.dateWindow.start);
    const end = new Date(viewport.dateWindow.end);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) return { start, end };
  }
  if (viewport.range === "ALL") return {};
  return { start: subtractTimeRange(now, viewport.range) };
}

function loadResult(output: SeriesLoadOutput): Exclude<SeriesLoadOutput, readonly SeriesPoint[]> {
  if (Array.isArray(output)) return { points: output };
  const result = output as Exclude<SeriesLoadOutput, readonly SeriesPoint[]>;
  if (!result || !Array.isArray(result.points)) throw new Error("Series loader returned no points.");
  return result;
}

export async function resolveLoadedSeries(
  definition: LoadedSeriesDefinition,
  request: { viewport: ChartViewportSpec; ticker?: string; signal?: AbortSignal },
  now = new Date(),
): Promise<ResolvedSeries> {
  const ticker = request.ticker?.trim().toUpperCase() || undefined;
  const { points, warning, attribution } = loadResult(await definition.load({
    ...seriesLoadWindow(request.viewport, now),
    ...(ticker ? { ticker } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  }));
  const id = ticker ? `${definition.id}/${ticker}` : definition.id;
  const style = definition.style ?? "line";
  return {
    id,
    label: ticker ? `${ticker} · ${definition.name}` : definition.name,
    color: seriesColor(id),
    unit: definition.unit,
    unitGroup: seriesUnitGroup(definition.unit),
    nativeFrequency: nativeFrequency(definition.frequency),
    dataShape: "scalar",
    style,
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: style === "step" ? "step-after" : "none",
    ...(warning ? { warning } : {}),
    ...(attribution ? { attribution: { ...attribution } } : {}),
    points: normalizeSeriesPoints(points),
  };
}
