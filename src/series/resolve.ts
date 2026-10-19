import { MAX_CHART_SERIES_POINTS } from "../capabilities/chart-series";
import { subtractTimeRange } from "../time-series/date-window";
import type {
  ChartViewportSpec,
  ResolvedSeries,
  SeriesPeriod,
  TimeSeriesPoint,
} from "../time-series/types";
import { getPresetResolution, type ManualChartResolution } from "../time-series/resolution";
import { SERIES_COLORS } from "../theme/series-colors";
import type {
  LoadedSeriesDefinition,
  SeriesFrequency,
  SeriesLine,
  SeriesLinesLoadResult,
  SeriesLoadOutput,
  SeriesLoadRequest,
  SeriesLoadResult,
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

function valuesByTime(points: readonly SeriesPoint[]): Map<number, number | null> {
  const byTime = new Map<number, number | null>();
  for (const point of points) {
    const date = point ? seriesPointDate(point.date) : null;
    if (!date) continue;
    const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
    byTime.set(date.getTime(), value);
  }
  return byTime;
}

/**
 * Oldest first, one point per instant (the last one given wins), at most the
 * chart's point limit. With `edge`, another line's points, each point spans
 * from its value to that line's value at the same instant: a band's range.
 */
export function normalizeSeriesPoints(points: readonly SeriesPoint[], edge?: readonly SeriesPoint[]): TimeSeriesPoint[] {
  const byTime = valuesByTime(points);
  const edges = edge ? valuesByTime(edge) : null;
  const sorted = [...byTime].sort(([left], [right]) => left - right);
  return sorted.slice(-MAX_CHART_SERIES_POINTS).map(([time, value]) => {
    const date = new Date(time);
    const other = edges?.get(time);
    return value !== null && other != null
      ? { date, observedAt: date, value, low: Math.min(value, other), high: Math.max(value, other) }
      : { date, observedAt: date, value };
  });
}

function nativeFrequency(frequency: SeriesFrequency): SeriesPeriod {
  return frequency === "intraday" || frequency === "irregular" ? "auto" : frequency;
}

/** Series in one unit share an axis; percentages share it with FRED's. */
function seriesUnitGroup(unit: string): string {
  return unit === "%" ? "percent" : `series:${unit.toLowerCase()}`;
}

/** One colour per id, so two loaded series on a chart are told apart; a series' lines take the colours after it. */
function seriesColor(id: string, lineIndex = 0): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SERIES_COLORS[(hash + lineIndex) % SERIES_COLORS.length]!;
}

/** The bar size a chart draws prices in: the one it was set to, else its range's default. */
function viewportResolution(viewport: ChartViewportSpec): ManualChartResolution {
  return viewport.resolution === "auto" ? getPresetResolution(viewport.range) : viewport.resolution;
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

function loadResult(output: SeriesLoadOutput, line: SeriesLine | undefined): SeriesLoadResult & { edge?: readonly SeriesPoint[] } {
  if (Array.isArray(output)) {
    if (line) throw new Error("Series loader returned points where its lines were expected.");
    return { points: output };
  }
  const result = output as Partial<SeriesLoadResult & SeriesLinesLoadResult> | null;
  if (line) {
    if (!result || !result.lines || typeof result.lines !== "object") throw new Error("Series loader returned no lines.");
    const { lines, ...rest } = result;
    const points = lines[line.id];
    const edge = line.fill ? lines[line.fill] : undefined;
    // A line the loaded data no longer has (the series changed under a saved chart) draws nothing.
    return { ...rest, points: Array.isArray(points) ? points : [], ...(Array.isArray(edge) ? { edge } : {}) };
  }
  if (!result || !Array.isArray(result.points)) throw new Error("Series loader returned no points.");
  return result as SeriesLoadResult;
}

/** How long one load is shared by the lines of a series that ask for it together. */
const SHARED_LOAD_MS = 2_000;

interface SharedLoad {
  output: Promise<SeriesLoadOutput>;
  controller: AbortController;
  /** Requests still waiting that can be called off. */
  waiting: number;
  /** A request that cannot be called off shares the load, so it runs to the end. */
  kept: boolean;
}

const sharedLoads = new WeakMap<LoadedSeriesDefinition, Map<string, SharedLoad>>();

/**
 * Loads a series once for all of its lines: a chart asks for each line on its
 * own, at the same time and for the same dates, and the loader runs once. The
 * loader's signal aborts when every request sharing the load has.
 */
function loadSeries(definition: LoadedSeriesDefinition, request: SeriesLoadRequest): Promise<SeriesLoadOutput> {
  if (!definition.lines?.length) return Promise.resolve(definition.load(request));
  const { signal, ...shared } = request;
  if (signal?.aborted) return Promise.reject(signal.reason);
  // A window measured back from now moves by milliseconds between the lines' requests.
  const minute = (date: Date | undefined) => date ? Math.floor(date.getTime() / 60_000) : null;
  const key = JSON.stringify([shared.ticker ?? null, minute(shared.start), minute(shared.end), shared.resolution ?? null]);
  let byKey = sharedLoads.get(definition);
  if (!byKey) sharedLoads.set(definition, byKey = new Map());
  let load = byKey.get(key);
  if (!load) {
    const controller = new AbortController();
    const output = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return definition.load({ ...shared, signal: controller.signal });
    });
    const entry: SharedLoad = { output, controller, waiting: 0, kept: false };
    load = entry;
    byKey.set(key, entry);
    const forget = () => {
      const timer = setTimeout(() => { if (byKey.get(key) === entry) byKey.delete(key); }, SHARED_LOAD_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    output.then(forget, forget);
  }
  const entry = load;
  if (!signal) {
    entry.kept = true;
    return entry.output;
  }
  entry.waiting += 1;
  return new Promise<SeriesLoadOutput>((resolve, reject) => {
    const onAbort = () => {
      entry.waiting -= 1;
      if (entry.waiting === 0 && !entry.kept) {
        if (byKey.get(key) === entry) byKey.delete(key);
        entry.controller.abort(signal.reason);
      }
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.output.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function resolveLoadedSeries(
  definition: LoadedSeriesDefinition,
  request: { viewport: ChartViewportSpec; ticker?: string; line?: SeriesLine; signal?: AbortSignal },
  now = new Date(),
): Promise<ResolvedSeries> {
  const ticker = request.ticker?.trim().toUpperCase() || undefined;
  const line = definition.lines?.length ? request.line ?? definition.lines[0] : undefined;
  const { points, edge, warning, attribution } = loadResult(await loadSeries(definition, {
    ...seriesLoadWindow(request.viewport, now),
    ...(ticker ? { ticker } : {}),
    resolution: viewportResolution(request.viewport),
    ...(request.signal ? { signal: request.signal } : {}),
  }), line);
  const seriesId = ticker ? `${definition.id}/${ticker}` : definition.id;
  const id = line ? `${definition.id}~${line.id}${ticker ? `/${ticker}` : ""}` : seriesId;
  const name = line ? `${definition.name} · ${line.name}` : definition.name;
  const style = line?.style ?? definition.style ?? "line";
  return {
    id,
    label: ticker ? `${ticker} · ${name}` : name,
    color: line?.color ?? definition.color ?? seriesColor(seriesId, line ? definition.lines!.indexOf(line) : 0),
    unit: definition.unit,
    unitGroup: seriesUnitGroup(definition.unit),
    // Drawn in the ticker's price: the chart puts it on that price's axis.
    ...(definition.placement === "price" && ticker ? { priceOf: ticker } : {}),
    nativeFrequency: nativeFrequency(definition.frequency),
    dataShape: "scalar",
    style,
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: style === "step" ? "step-after" : "none",
    ...(warning ? { warning } : {}),
    ...(attribution ? { attribution: { ...attribution } } : {}),
    points: normalizeSeriesPoints(points, edge),
  };
}
