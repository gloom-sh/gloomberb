/**
 * Map series in G: numbers over time for things with a place (chokepoint
 * transits, port calls). `GEO:<id or alias>` resolves through the server's
 * series index, so a series the server adds is chartable without a release.
 */
import {
  getGeoSeries,
  loadGeoCatalog,
  resolveGeoSeries,
  searchGeoSeries,
  type GeoRequest,
  type GeoSeriesSearchHit,
} from "../../../api-client/geo";
import { chartSeriesProvider, type ChartSeriesCapability, type ChartSeriesCatalogItem } from "../../../capabilities";
import { subtractTimeRange } from "../../../time-series/date-window";
import { SERIES_COLORS } from "../../../time-series/resolve";
import type { ChartViewportSpec, ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { GEO_SERIES_CAPABILITY_ID } from "../chart-composer/series-expression";
import { cloudGeoRequest } from "./client";

function catalogItem(hit: GeoSeriesSearchHit): ChartSeriesCatalogItem {
  return {
    seriesId: hit.alias ?? hit.id,
    label: hit.name,
    detail: `${hit.unit} · ${hit.frequency}`,
    style: "line",
  };
}

/** A capability series brings its own colour; one per id keeps two map series apart on one chart. */
function seriesColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SERIES_COLORS[hash % SERIES_COLORS.length]!;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The dates a viewport asks for, as the series route takes them. */
export function geoSeriesRange(viewport: ChartViewportSpec, now = new Date()): { from?: string; to?: string } {
  if (viewport.dateWindow) {
    return { from: viewport.dateWindow.start.slice(0, 10), to: viewport.dateWindow.end.slice(0, 10) };
  }
  if (viewport.range === "ALL") return {};
  return { from: isoDate(subtractTimeRange(now, viewport.range)) };
}

export async function resolveGeoChartSeries(
  request: GeoRequest,
  token: string,
  viewport: ChartViewportSpec,
  signal?: AbortSignal,
): Promise<ResolvedSeries> {
  const hit = await resolveGeoSeries(request, token, signal).catch(() => null);
  const payload = await getGeoSeries(request, hit?.id ?? token, geoSeriesRange(viewport), signal).catch((error: unknown) => {
    throw hit ? error : new Error(`No map series named ${token}.`);
  });
  const points: TimeSeriesPoint[] = (payload.points ?? []).flatMap(([day, value]) => {
    const date = new Date(`${day}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && Number.isFinite(value) ? [{ date, observedAt: date, value }] : [];
  });
  return {
    id: `${GEO_SERIES_CAPABILITY_ID}:${payload.id}`,
    label: payload.name,
    color: seriesColor(payload.id),
    unit: payload.unit,
    unitGroup: `geo:${payload.unit}`,
    nativeFrequency: payload.frequency,
    dataShape: "scalar",
    style: "line",
    transform: "raw",
    axis: "left",
    panelId: "main",
    interpolation: "none",
    points,
  };
}

export function createGeoChartSeriesCapability(request: GeoRequest = cloudGeoRequest): ChartSeriesCapability {
  const search = async (query: string, limit: number, signal?: AbortSignal) => {
    const { series } = await searchGeoSeries(request, query, signal).catch(() => ({ series: [] as GeoSeriesSearchHit[] }));
    return series.slice(0, limit).map(catalogItem);
  };
  return chartSeriesProvider({
    id: GEO_SERIES_CAPABILITY_ID,
    name: "Map Series",
    provider: {
      catalog: ({ limit, signal }) => search("", limit ?? 8, signal),
      search: ({ query, limit, signal }) => search(query ?? "", limit ?? 8, signal),
      resolve: ({ seriesId, viewport, signal }) => resolveGeoChartSeries(request, seriesId, viewport, signal),
    },
  });
}

const CHOKEPOINTS_LAYER = "chokepoints";

function compact(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9.]+/g, "");
}

/**
 * The chokepoints' main series (one per strait, as the catalog lists them),
 * written as the short aliases G takes.
 */
export async function chokepointSeriesIds(request: GeoRequest, signal?: AbortSignal): Promise<string[]> {
  const [catalog, { series }] = await Promise.all([loadGeoCatalog(request, { signal }), searchGeoSeries(request, "", signal)]);
  const aliasById = new Map(series.map((hit) => [hit.id, hit.alias]));
  const main = catalog?.layers.find((layer) => layer.id === CHOKEPOINTS_LAYER)?.series ?? [];
  if (main.length) return main.map((entry) => aliasById.get(entry.id) ?? entry.id);
  // Without the catalog, one series per chokepoint: the first the index lists.
  const seen = new Set<string>();
  return series.flatMap((hit) => {
    if (hit.layer !== CHOKEPOINTS_LAYER || !hit.entityId || seen.has(hit.entityId)) return [];
    seen.add(hit.entityId);
    return [hit.alias ?? hit.id];
  });
}

/**
 * The series a typed chokepoint names: "suez", "Bab el-Mandeb" and "Strait
 * of Hormuz" all find the strait's main transit series.
 */
export async function chokepointSeriesFor(request: GeoRequest, typed: string, signal?: AbortSignal): Promise<string> {
  const wanted = compact(typed);
  const { series } = await searchGeoSeries(request, typed, signal).catch(() => ({ series: [] as GeoSeriesSearchHit[] }));
  const chokepoints = series.filter((hit) => hit.layer === CHOKEPOINTS_LAYER);
  const exact = chokepoints.find((hit) => hit.alias && compact(hit.alias) === wanted);
  // A main transit series has the plain alias (SUEZ), its splits a suffix (SUEZ.TANKER).
  const named = chokepoints.find((hit) => hit.alias && !hit.alias.includes("."));
  return exact?.alias ?? named?.alias ?? wanted;
}
