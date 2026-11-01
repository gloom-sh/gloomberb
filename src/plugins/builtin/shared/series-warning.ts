/**
 * What a loaded catalog series says of an old copy. A copy that answered
 * because its refresh failed carries when it was saved (`savedAt`), which the
 * chart's footer shows as "saved copy from …", the note every pane gives it.
 * A cached copy the source has not updated since is a note on the chart.
 */
export function cachedSeriesNote(resource: { stale?: boolean; refreshError?: string | null; savedAt?: number | null }): {
  warning?: string;
  savedAt?: number;
} {
  if (resource.savedAt != null && Number.isFinite(resource.savedAt)) return { savedAt: resource.savedAt };
  if (resource.refreshError) return { warning: `Refresh failed (${resource.refreshError}); showing cached data.` };
  return resource.stale ? { warning: "Showing cached data; the source has not updated since." } : {};
}
