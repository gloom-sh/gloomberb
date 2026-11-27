import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh, type AutoRefreshOptions } from "../../../react/auto-refresh";

type AsyncResourceOptions<T> = NonNullable<Parameters<typeof useAsyncResource<T>>[1]>;

export type UsePaneResourceOptions<T> = AsyncResourceOptions<T> & {
  focused: boolean;
  /**
   * Auto-refresh config. Defaults to refreshing on `resource.updatedAt`. Pass `false`
   * to disable, or an object to override `lastUpdated` / `intervalMs` / `enabled`.
   */
  autoRefresh?: boolean | (AutoRefreshOptions & {
    lastUpdated?: number | null;
  });
  /**
   * Manual refresh key (`r`) config. Defaults to `{ enabled: true }` calling `resource.reload`.
   * Pass `false` to disable, or an object to override `enabled` / `skipWhileLoading` / `onReload`.
   */
  refreshKey?: boolean | {
    enabled?: boolean;
    skipWhileLoading?: boolean;
    onReload?: () => void;
  };
};

/**
 * Standard async pane data hook combining `useAsyncResource`, `useAutoRefresh`,
 * and `usePaneRefreshKey`.
 */
export function usePaneResource<T>(
  loader: ((force: boolean) => Promise<T>) | null,
  { focused, autoRefresh = true, refreshKey = true, ...resourceOptions }: UsePaneResourceOptions<T>,
) {
  const resource = useAsyncResource(loader, resourceOptions);
  const autoOpts = typeof autoRefresh === "object" ? autoRefresh : undefined;
  const autoLastUpdated = autoRefresh === false
    ? null
    : autoOpts && "lastUpdated" in autoOpts
      ? autoOpts.lastUpdated ?? null
      : resource.updatedAt;
  useAutoRefresh(autoLastUpdated, resource.load, {
    ...(autoOpts?.intervalMs !== undefined ? { intervalMs: autoOpts.intervalMs } : {}),
    enabled: autoRefresh !== false && (autoOpts?.enabled ?? true),
  });
  const keyOpts = typeof refreshKey === "object" ? refreshKey : undefined;
  const keyEnabled = refreshKey !== false && (keyOpts?.enabled ?? true) && (!keyOpts?.skipWhileLoading || !resource.loading);
  usePaneRefreshKey(keyOpts?.onReload ?? resource.reload, { focused, enabled: keyEnabled });
  return resource;
}
