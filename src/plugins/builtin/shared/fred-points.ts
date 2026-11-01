import { apiClient } from "../../../api-client";
import { loadCachedFredSeries } from "../../../sources/gloomberb-cloud/fred-series";

/**
 * A FRED series from `start` on, oldest first, through the shared FRED cache;
 * `savedAt` when a failed refresh left the copy saved then answering.
 */
export async function loadFredPoints(seriesId: string, start?: Date): Promise<{
  points: Array<{ date: string; value: number | null }>;
  stale: boolean;
  refreshError?: string;
  savedAt?: number;
}> {
  const startDate = start ? start.toISOString().slice(0, 10) : "1900-01-01";
  const result = await loadCachedFredSeries(
    { seriesId, startDate, sortOrder: "asc" },
    () => apiClient.getCloudFredSeries(seriesId, { startDate, sortOrder: "asc" }),
  );
  return {
    points: (result.data.observations ?? []).map((row) => ({ date: row.date, value: row.value })),
    stale: result.stale,
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
    ...(result.source === "stale-fallback" ? { savedAt: result.fetchedAt } : {}),
  };
}
