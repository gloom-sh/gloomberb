/** The note a loaded catalog series carries when it is drawn from an old copy. */
export function cachedSeriesWarning(resource: { stale?: boolean; refreshError?: string | null }): string | undefined {
  if (resource.refreshError) return `Refresh failed (${resource.refreshError}); showing cached data.`;
  return resource.stale ? "Showing cached data; the source has not updated since." : undefined;
}
