import { debugLog } from "../utils/debug-log";
import type {
  CapabilitySeriesSource,
  ChartSeriesSpec,
  ChartViewportSpec,
  ResolvedSeries,
  SeriesStyle,
  SeriesTimestampMode,
  SeriesTransform,
  TimeSeriesPoint,
} from "../time-series/types";
import type {
  CapabilityInvoker,
  CapabilitySchema,
  ChartSeriesCatalogItem,
  ChartSeriesCatalogRequest,
  ChartSeriesResolveRequest,
} from "./types";

export const CHART_SERIES_CAPABILITY_KIND = "chart-series";
export const MAX_CHART_SERIES_CATALOG_ITEMS = 32;
export const MAX_CHART_SERIES_POINTS = 20_000;

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SERIES_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~%:/-]{0,239}$/;
const chartSeriesLog = debugLog.createLogger("chart-series");
const ranges = new Set(["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"]);
const resolutions = new Set(["auto", "1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk", "1mo"]);
const periods = new Set(["auto", "daily", "weekly", "monthly", "quarterly", "annual", "ttm"]);
const styles = new Set(["line", "area", "step", "columns", "points", "candles", "ohlc", "hlc"]);
const transforms = new Set(["raw", "percent", "index100", "yoy", "qoq", "log"]);
const shapes = new Set(["scalar", "ohlcv", "event", "band"]);
const axes = new Set(["left", "right"]);
const interpolations = new Set(["none", "step-after"]);

export function isValidChartCapabilityId(value: string): boolean {
  return CAPABILITY_ID_PATTERN.test(value);
}

export function isValidChartSeriesId(value: string): boolean {
  return SERIES_ID_PATTERN.test(value);
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid chart series ${path}: ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object.");
  return value as Record<string, unknown>;
}

function onlyKeys(input: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const extra = Object.keys(input).find((key) => !allowed.includes(key));
  if (extra) fail(path, `unsupported field "${extra}".`);
}

function boundedString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(path, `expected a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedString(value, path, max);
}

function enumValue<T extends string>(value: unknown, path: string, allowed: Set<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) fail(path, `unsupported value ${String(value)}.`);
  return value as T;
}

function finiteNumber(value: unknown, path: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number.");
  return value;
}

function optionalNumber(value: unknown, path: string, nullable = false): number | null | undefined {
  return value === undefined ? undefined : finiteNumber(value, path, nullable);
}

function dateValue(value: unknown, path: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) fail(path, "expected a valid date.");
  return date;
}

function catalogRequest(value: unknown): ChartSeriesCatalogRequest {
  const input = object(value, "catalog request");
  onlyKeys(input, "catalog request", ["query", "limit"]);
  const query = input.query === undefined ? undefined : optionalString(input.query, "catalog query", 200);
  const limit = input.limit === undefined ? 8 : input.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_CHART_SERIES_CATALOG_ITEMS) {
    fail("catalog limit", `expected an integer from 1 to ${MAX_CHART_SERIES_CATALOG_ITEMS}.`);
  }
  return { ...(query !== undefined ? { query } : {}), limit: limit as number };
}

function viewport(value: unknown): ChartViewportSpec {
  const input = object(value, "resolve viewport");
  onlyKeys(input, "resolve viewport", ["range", "resolution", "dateWindow", "maxPoints"]);
  const range = enumValue<ChartViewportSpec["range"]>(input.range, "viewport range", ranges);
  const resolution = enumValue<ChartViewportSpec["resolution"]>(input.resolution, "viewport resolution", resolutions);
  let dateWindow: ChartViewportSpec["dateWindow"];
  if (input.dateWindow !== undefined) {
    const window = object(input.dateWindow, "viewport date window");
    onlyKeys(window, "viewport date window", ["start", "end"]);
    const start = boundedString(window.start, "viewport start", 40);
    const end = boundedString(window.end, "viewport end", 40);
    const startTime = Date.parse(start);
    const endTime = Date.parse(end);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
      fail("viewport date window", "expected valid ordered bounds.");
    }
    dateWindow = { start, end };
  }
  let maxPoints: number | undefined;
  if (input.maxPoints !== undefined) {
    if (!Number.isInteger(input.maxPoints) || (input.maxPoints as number) < 1 || (input.maxPoints as number) > 10_000) {
      fail("viewport maxPoints", "expected an integer from 1 to 10000.");
    }
    maxPoints = input.maxPoints as number;
  }
  return { range, resolution, ...(dateWindow ? { dateWindow } : {}), ...(maxPoints ? { maxPoints } : {}) };
}

function resolveRequest(value: unknown): ChartSeriesResolveRequest {
  const input = object(value, "resolve request");
  onlyKeys(input, "resolve request", ["seriesId", "viewport"]);
  const seriesId = boundedString(input.seriesId, "series ID", 240);
  if (!isValidChartSeriesId(seriesId)) fail("series ID", "contains unsupported characters.");
  return { seriesId, viewport: viewport(input.viewport) };
}

function catalogItem(value: unknown, index: number): ChartSeriesCatalogItem {
  const item = object(value, `catalog item ${index}`);
  onlyKeys(item, `catalog item ${index}`, ["seriesId", "label", "description", "detail", "style", "transform"]);
  const seriesId = boundedString(item.seriesId, `catalog item ${index} series ID`, 240);
  if (!isValidChartSeriesId(seriesId)) fail(`catalog item ${index} series ID`, "contains unsupported characters.");
  return {
    seriesId,
    label: boundedString(item.label, `catalog item ${index} label`, 160),
    ...(optionalString(item.description, `catalog item ${index} description`, 500) !== undefined
      ? { description: item.description as string }
      : {}),
    ...(optionalString(item.detail, `catalog item ${index} detail`, 100) !== undefined
      ? { detail: item.detail as string }
      : {}),
    ...(item.style !== undefined ? { style: enumValue<SeriesStyle>(item.style, `catalog item ${index} style`, styles) } : {}),
    ...(item.transform !== undefined ? { transform: enumValue<SeriesTransform>(item.transform, `catalog item ${index} transform`, transforms) } : {}),
  };
}

function catalogOutput(value: unknown): ChartSeriesCatalogItem[] {
  if (!Array.isArray(value)) fail("catalog output", "expected an array.");
  if (value.length > MAX_CHART_SERIES_CATALOG_ITEMS) {
    fail("catalog output", `returned ${value.length} items; maximum is ${MAX_CHART_SERIES_CATALOG_ITEMS}.`);
  }
  return value.map(catalogItem);
}

function point(value: unknown, index: number): TimeSeriesPoint {
  const input = object(value, `point ${index}`);
  onlyKeys(input, `point ${index}`, [
    "date", "observedAt", "availableAt", "value", "open", "high", "low", "close", "volume", "periodLabel", "provenance",
  ]);
  const provenance = input.provenance === undefined ? undefined : object(input.provenance, `point ${index} provenance`);
  if (provenance) onlyKeys(provenance, `point ${index} provenance`, ["providerId", "quality"]);
  const quality = provenance?.quality === undefined
    ? undefined
    : enumValue<"reported" | "derived" | "estimated">(
        provenance.quality,
        `point ${index} provenance quality`,
        new Set(["reported", "derived", "estimated"]),
      );
  return {
    date: dateValue(input.date, `point ${index} date`),
    observedAt: dateValue(input.observedAt, `point ${index} observedAt`),
    ...(input.availableAt !== undefined ? { availableAt: dateValue(input.availableAt, `point ${index} availableAt`) } : {}),
    value: finiteNumber(input.value, `point ${index} value`, true),
    ...(input.open !== undefined ? { open: optionalNumber(input.open, `point ${index} open`, true) } : {}),
    ...(input.high !== undefined ? { high: optionalNumber(input.high, `point ${index} high`, true) } : {}),
    ...(input.low !== undefined ? { low: optionalNumber(input.low, `point ${index} low`, true) } : {}),
    ...(input.close !== undefined ? { close: optionalNumber(input.close, `point ${index} close`, true) } : {}),
    ...(input.volume !== undefined ? { volume: optionalNumber(input.volume, `point ${index} volume`, true) } : {}),
    ...(input.periodLabel !== undefined ? { periodLabel: boundedString(input.periodLabel, `point ${index} period label`, 120) } : {}),
    ...(provenance ? {
      provenance: {
        ...(provenance.providerId !== undefined
          ? { providerId: boundedString(provenance.providerId, `point ${index} provider ID`, 80) }
          : {}),
        ...(quality ? { quality } : {}),
      },
    } : {}),
  };
}

function resolvedOutput(value: unknown): ResolvedSeries {
  const input = object(value, "resolve output");
  onlyKeys(input, "resolve output", [
    "id", "label", "color", "unit", "unitGroup", "nativeFrequency", "timestampMode", "dataShape", "style", "transform",
    "axis", "panelId", "interpolation", "timeBasis", "latestChangePercent", "points", "warning", "hidden",
  ]);
  if (!Array.isArray(input.points)) fail("resolve output points", "expected an array.");
  if (input.points.length > MAX_CHART_SERIES_POINTS) {
    fail("resolve output points", `returned ${input.points.length} points; maximum is ${MAX_CHART_SERIES_POINTS}.`);
  }
  const timeBasis = input.timeBasis === undefined ? undefined : object(input.timeBasis, "resolve output time basis");
  if (timeBasis) onlyKeys(timeBasis, "resolve output time basis", ["kind", "timeZone", "cadenceMs"]);
  const kind = timeBasis?.kind === undefined ? undefined : enumValue<"market">(timeBasis.kind, "time basis kind", new Set(["market"]));
  const warning = optionalString(input.warning, "resolve output warning", 500);
  return {
    id: boundedString(input.id, "resolve output ID", 160),
    label: boundedString(input.label, "resolve output label", 160),
    color: boundedString(input.color, "resolve output color", 64),
    unit: typeof input.unit === "string" && input.unit.length <= 64 ? input.unit : fail("resolve output unit", "expected a string of at most 64 characters."),
    unitGroup: boundedString(input.unitGroup, "resolve output unit group", 64),
    nativeFrequency: enumValue(input.nativeFrequency, "resolve output frequency", periods),
    ...(input.timestampMode !== undefined
      ? { timestampMode: enumValue<SeriesTimestampMode>(input.timestampMode, "resolve output timestamp mode", new Set(["available-at", "period-end"])) }
      : {}),
    dataShape: enumValue(input.dataShape, "resolve output data shape", shapes),
    style: enumValue(input.style, "resolve output style", styles),
    transform: enumValue(input.transform, "resolve output transform", transforms),
    axis: enumValue(input.axis, "resolve output axis", axes),
    panelId: boundedString(input.panelId, "resolve output panel ID", 80),
    interpolation: enumValue(input.interpolation, "resolve output interpolation", interpolations),
    ...(timeBasis ? {
      timeBasis: {
        kind: kind!,
        timeZone: boundedString(timeBasis.timeZone, "time basis timezone", 80),
        ...(timeBasis.cadenceMs !== undefined
          ? { cadenceMs: finiteNumber(timeBasis.cadenceMs, "time basis cadence") as number }
          : {}),
      },
    } : {}),
    ...(input.latestChangePercent !== undefined
      ? { latestChangePercent: finiteNumber(input.latestChangePercent, "resolve output latest change") as number }
      : {}),
    points: input.points.map(point),
    ...(warning !== undefined ? { warning } : {}),
    ...(input.hidden !== undefined
      ? typeof input.hidden === "boolean" ? { hidden: input.hidden } : fail("resolve output hidden", "expected a boolean.")
      : {}),
  };
}

export const chartSeriesCatalogRequestSchema: CapabilitySchema<ChartSeriesCatalogRequest> = { parse: catalogRequest };
export const chartSeriesCatalogOutputSchema: CapabilitySchema<ChartSeriesCatalogItem[]> = { parse: catalogOutput };
export const chartSeriesResolveRequestSchema: CapabilitySchema<ChartSeriesResolveRequest> = { parse: resolveRequest };
export const chartSeriesResolveOutputSchema: CapabilitySchema<ResolvedSeries> = { parse: resolvedOutput };

export function chartSeriesCapabilityManifests(invoker: CapabilityInvoker) {
  return invoker.capabilityManifests(CHART_SERIES_CAPABILITY_KIND);
}

export async function searchChartSeriesCapabilities(
  invoker: CapabilityInvoker,
  query: string,
  limit = 8,
  signal?: AbortSignal,
): Promise<Array<ChartSeriesCatalogItem & { capabilityId: string; capabilityName: string }>> {
  const manifests = chartSeriesCapabilityManifests(invoker);
  const results = await Promise.allSettled(manifests.map(async (manifest) => {
    const items = await invoker.invokeCapability<ChartSeriesCatalogItem[]>(
      manifest.id,
      query.trim() ? "search" : "catalog",
      { query, limit },
      { signal },
    );
    return items.map((item) => ({
      ...item,
      capabilityId: manifest.id,
      capabilityName: manifest.name,
    }));
  }));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      chartSeriesLog.warn("Chart series provider catalog failed", {
        capabilityId: manifests[index]?.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []).slice(0, limit);
}

export function chartSeriesSourceKey(
  source: CapabilitySeriesSource,
  viewport?: ChartViewportSpec,
): string {
  return JSON.stringify([
    "chart-series",
    source.capabilityId,
    source.seriesId,
    viewport ? {
      range: viewport.range,
      resolution: viewport.resolution,
      dateWindow: viewport.dateWindow ?? null,
      maxPoints: viewport.maxPoints ?? null,
    } : null,
  ]);
}

export function createChartSeriesResolver(invoker: CapabilityInvoker) {
  return async (
    source: CapabilitySeriesSource,
    viewport: ChartViewportSpec,
    _spec: ChartSeriesSpec,
  ): Promise<ResolvedSeries> => invoker.invokeCapability<ResolvedSeries>(
    source.capabilityId,
    "resolve",
    { seriesId: source.seriesId, viewport } satisfies ChartSeriesResolveRequest,
  );
}
