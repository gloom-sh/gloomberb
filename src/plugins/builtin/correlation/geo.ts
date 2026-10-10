/**
 * Map series (`GEO:HORMUZ`) in CORR, read through the same parser and
 * resolver G uses, so an alias G charts is one CORR correlates.
 */
import { loadGeoCatalog, type GeoRequest } from "../../../api-client/geo";
import type { TimeRange } from "../../../time-series/range";
import { GEO_SERIES_CAPABILITY_ID, parseSeriesExpression } from "../chart-composer/series-expression";
import { resolveGeoChartSeries } from "../world-venue-map/geo-series";
import { dailyValues, type DailyClose } from "./compute";
import { CORRELATION_HISTORY_RESOLUTION } from "./history";

/** The map series a CORR entry names, or null for a ticker. */
export function geoSeriesToken(entry: string): string | null {
  if (!/^GEO:/i.test(entry.trim())) return null;
  const parsed = parseSeriesExpression(entry);
  return parsed?.kind === "capability" && parsed.capabilityId === GEO_SERIES_CAPABILITY_ID ? parsed.seriesId : null;
}

/** A map series' daily values over the range. A server without map series says so instead of "not found". */
export async function loadGeoCorrelationHistory(
  request: GeoRequest,
  seriesId: string,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<DailyClose[]> {
  try {
    const series = await resolveGeoChartSeries(request, seriesId, { range, resolution: CORRELATION_HISTORY_RESOLUTION }, signal);
    return dailyValues(series.points);
  } catch (error) {
    signal?.throwIfAborted();
    if (!await loadGeoCatalog(request, { signal })) throw new Error("Map series unavailable.");
    throw error;
  }
}
