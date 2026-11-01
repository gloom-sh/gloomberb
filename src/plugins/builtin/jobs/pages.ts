import { useCallback, useRef, useState } from "react";
import { logFailure } from "../../../utils/log-failure";

/**
 * Pages appended past what the first response carried. Keyed on the first
 * response's identity so a refresh drops them instead of stacking stale rows.
 */
interface Appended<T> {
  key: string;
  items: T[];
  nextOffset: number;
  exhausted: boolean;
}

export function useAppendedPages<T>(
  key: string,
  firstCount: number,
  total: number,
  loadPage: (offset: number) => Promise<T[]>,
): { items: T[]; hasMore: boolean; loadingMore: boolean; loadMore: () => void } {
  const [pages, setPages] = useState<Appended<T> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inFlight = useRef<string | null>(null);
  const current = pages?.key === key ? pages : null;
  const loaded = firstCount + (current?.items.length ?? 0);
  const hasMore = !current?.exhausted && loaded < total;
  const loadMore = useCallback(() => {
    if (!hasMore || inFlight.current === key) return;
    inFlight.current = key;
    setLoadingMore(true);
    const offset = current?.nextOffset ?? firstCount;
    loadPage(offset)
      .then((items) => {
        setPages((previous) => {
          const base = previous?.key === key ? previous.items : [];
          return { key, items: [...base, ...items], nextOffset: offset + items.length, exhausted: items.length === 0 };
        });
      })
      // The rows already loaded stay; only the next page failed, and a
      // later scroll asks again.
      .catch(logFailure("jobs.pages", "Load more job postings failed"))
      .finally(() => {
        if (inFlight.current === key) inFlight.current = null;
        setLoadingMore(false);
      });
  }, [current, firstCount, hasMore, key, loadPage]);
  return { items: current?.items ?? [], hasMore, loadingMore, loadMore };
}
