import { ApiRequestError } from "../../../api-client/errors";
import { logFailure } from "../../../utils/log-failure";
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
import { SERIES_COLORS } from "../../../theme/series-colors";
import type { ChartViewportSpec, ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { formatGeoSeriesExpression, GEO_SERIES_CAPABILITY_ID } from "../chart-composer/series-expression";
import type { SeriesDefinition } from "../../../series/types";
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
  let indexFailed = false;
  const hit = await resolveGeoSeries(request, token, signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    logFailure("world-venue-map.geo-series", "Resolve map series failed")(error);
    indexFailed = true;
    return null;
  });
  const payload = await getGeoSeries(request, hit?.id ?? token, geoSeriesRange(viewport), signal).catch((error: unknown) => {
    if (signal?.aborted) throw error;
    if (hit) throw error;
    if (!indexFailed && error instanceof ApiRequestError && error.status === 404) {
      throw new Error(`No map series named ${token}.`);
    }
    throw new Error("Map series unavailable.", { cause: error });
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
    // A chart of map series alone cites who published them, as `fn CHOKE` and its export do.
    ...(payload.publisher ? { attribution: { source: payload.publisher, publisher: payload.publisher } } : {}),
  };
}

export function createGeoChartSeriesCapability(request: GeoRequest = cloudGeoRequest): ChartSeriesCapability {
  const search = async (query: string, limit: number, signal?: AbortSignal) => {
    const { series } = await searchGeoSeries(request, query, signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      logFailure("world-venue-map.geo-series", "Search map series failed")(error);
      throw new Error("Map series search unavailable.", { cause: error });
    });
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
 * The straits trade and oil markets watch, in the order CHOKE charts them.
 * The busiest by count are local Asian straits, which say less about trade.
 */
export const KEY_CHOKEPOINTS = ["SUEZ", "PANAMA", "HORMUZ", "BABELMANDEB", "MALACCA", "BOSPHORUS"];

const CHOKEPOINT_NAMES: Readonly<Record<string, string>> = {
  SUEZ: "Suez Canal",
  PANAMA: "Panama Canal",
  HORMUZ: "Strait of Hormuz",
  BABELMANDEB: "Bab el-Mandeb",
  MALACCA: "Strait of Malacca",
  BOSPHORUS: "Bosphorus",
};

/**
 * The key straits as a legend of all six can carry them: the full series
 * names ("Strait of Hormuz transits") would be cut to a fragment each. The
 * chart's title and unit already say these are transits.
 */
const CHOKEPOINT_SHORT_NAMES: Readonly<Record<string, string>> = {
  SUEZ: "Suez",
  PANAMA: "Panama",
  HORMUZ: "Hormuz",
  BABELMANDEB: "Bab el-Mandeb",
  MALACCA: "Malacca",
  BOSPHORUS: "Bosphorus",
};

/** A key strait's short legend name; undefined for any other series, which keeps the name the index gives it. */
export function chokepointShortName(alias: string): string | undefined {
  return CHOKEPOINT_SHORT_NAMES[alias.toUpperCase()];
}

/**
 * Who publishes the chokepoints' daily transits, as the server's chokepoints
 * layer names them (`publisher`); the catalog lists the key straits offline.
 */
const CHOKEPOINT_PUBLISHER = "IMF PortWatch";

/**
 * The key straits' daily transits in the catalog. The rest of the map's
 * series stay a `GEO:` expression or a map click away: the server's index of
 * them changes without a release.
 */
export const CHOKEPOINT_SERIES: readonly SeriesDefinition[] = KEY_CHOKEPOINTS.map((alias) => ({
  id: `geo:${alias.toLowerCase()}`,
  name: `${CHOKEPOINT_NAMES[alias] ?? alias} transits`,
  unit: "count",
  frequency: "daily",
  group: "Alternative data",
  publisher: CHOKEPOINT_PUBLISHER,
  tags: ["chokepoint", "shipping", "transits", "vessels", "trade"],
  expression: formatGeoSeriesExpression(alias),
}));

/**
 * CHOKE's series as the short aliases G takes: the key straits the index
 * has, else the chokepoints' main series as the catalog lists them.
 */
export async function chokepointSeriesIds(request: GeoRequest, signal?: AbortSignal): Promise<string[]> {
  const [catalog, { series }] = await Promise.all([loadGeoCatalog(request, { signal }), searchGeoSeries(request, "", signal)]);
  const known = new Set(series.filter((hit) => hit.layer === CHOKEPOINTS_LAYER && hit.alias).map((hit) => hit.alias!.toUpperCase()));
  const key = KEY_CHOKEPOINTS.filter((alias) => known.has(alias));
  if (key.length >= 3) return key;
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

/** A series' chokepoint as the index names it: "Strait of Hormuz transits" is "Strait of Hormuz". */
function chokepointName(seriesName: string): string {
  return seriesName.replace(/\s+transits$/i, "");
}

/** A chokepoint's name without what straits and canals share ("Strait of Hormuz" is Hormuz, "Suez Canal" Suez), as it is typed short. */
function chokepointCore(name: string): string {
  return compact(chokepointName(name)
    .replace(/^strait of\s+/i, "")
    .replace(/\s+(strait|canal|channel|passage)$/i, ""));
}

function matchIndexedChokepoint(series: readonly GeoSeriesSearchHit[], wanted: string): string | null {
  const chokepoints = series.filter((hit) => hit.layer === CHOKEPOINTS_LAYER && hit.alias);
  // A main transit series has the plain alias (SUEZ), its splits a suffix (SUEZ.TANKER).
  const exact = chokepoints.find((hit) => compact(hit.alias!) === wanted);
  if (exact) return exact.alias!;
  const main = chokepoints.filter((hit) => !hit.alias!.includes("."));
  const named = main.find((hit) => compact(chokepointName(hit.name)) === wanted || chokepointCore(hit.name) === wanted);
  if (named) return named.alias!;
  // Part of one strait's name ("mandeb") finds it; part of several ("strait") names none.
  return main.length === 1 ? main[0]!.alias! : null;
}

function matchKeyChokepoint(wanted: string): string | null {
  return KEY_CHOKEPOINTS.find((alias) => alias === wanted || compact(CHOKEPOINT_NAMES[alias] ?? "") === wanted
    || chokepointCore(CHOKEPOINT_NAMES[alias] ?? "") === wanted) ?? null;
}

/**
 * The series a typed chokepoint names: "suez", "Bab el-Mandeb" and "Strait
 * of Hormuz" all find the strait's main transit series. Null for text that
 * names no chokepoint (a ticker), so CHOKE can say which exist. Without the
 * series index, the key straits are still known by name.
 */
export async function chokepointSeriesFor(request: GeoRequest, typed: string, signal?: AbortSignal): Promise<string | null> {
  const wanted = compact(typed);
  if (!wanted) return null;
  try {
    const { series } = await searchGeoSeries(request, typed, signal);
    return matchIndexedChokepoint(series, wanted) ?? matchKeyChokepoint(wanted);
  } catch (error) {
    if (signal?.aborted) throw error;
    logFailure("world-venue-map.geo-series", "Find chokepoint series failed")(error);
    const known = matchKeyChokepoint(wanted);
    if (known) return known;
    throw new Error("Chokepoint search unavailable. Try again.", { cause: error });
  }
}

/** What CHOKE tells text that names no chokepoint: the key straits, as it takes them typed. */
export function unknownChokepointMessage(typed: string): string {
  const names = KEY_CHOKEPOINTS.map((alias) => (CHOKEPOINT_SHORT_NAMES[alias] ?? alias).toUpperCase());
  return `No chokepoint named ${typed.trim()}. Try CHOKE ${names.slice(0, -1).join(", ")} or ${names.at(-1)}.`;
}
