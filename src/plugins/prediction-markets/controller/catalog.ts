import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  buildPredictionCatalogCacheKey,
  buildPredictionCatalogResourceKey,
  samePredictionCatalogSummaries,
  updatePredictionErrorState,
  updatePredictionPendingCounts,
} from "../cache";
import {
  type PredictionCatalogSource,
  formatPredictionLoadError,
  getPredictionCatalogStatus,
} from "./status";
import { useAutoRefresh } from "../../builtin/shared/auto-refresh";
import { getCachedPredictionResource } from "../services/fetch";
import { kalshiCatalogCursor, loadKalshiCatalog, loadMoreKalshiCatalog } from "../services/kalshi/adapter";
import { loadMorePolymarketCatalog, loadPolymarketCatalog, nextPolymarketCatalogOffset } from "../services/polymarket/adapter";
import type {
  PredictionCategoryId,
  PredictionMarketSummary,
} from "../types";

type PredictionCatalogCache = Record<string, PredictionMarketSummary[]>;
export type PredictionCatalogCacheSetter = Dispatch<SetStateAction<PredictionCatalogCache>>;

interface UsePredictionCatalogDataOptions {
  categoryId: PredictionCategoryId;
  includeKalshi: boolean;
  includePolymarket: boolean;
  searchQuery: string;
}

export function usePredictionCatalogData({
  categoryId,
  includeKalshi,
  includePolymarket,
  searchQuery,
}: UsePredictionCatalogDataOptions) {
  const [catalogCache, setCatalogCache] = useState<PredictionCatalogCache>({});
  const [catalogPending, setCatalogPending] = useState<Record<string, number>>(
    {},
  );
  const [catalogErrors, setCatalogErrors] = useState<
    Record<string, string | null>
  >({});
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);
  const [polymarketLoadedAt, setPolymarketLoadedAt] = useState<number | null>(null);
  const [kalshiLoadedAt, setKalshiLoadedAt] = useState<number | null>(null);
  const [polymarketNextOffset, setPolymarketNextOffset] = useState<number | null>(null);
  const [kalshiNextCursor, setKalshiNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const activeCatalogRef = useRef<PredictionCatalogCache>({});

  const normalizedCatalogQuery = debouncedSearchQuery.trim().toLowerCase();
  const polymarketCatalogKey = useMemo(
    () =>
      buildPredictionCatalogCacheKey(
        "polymarket",
        categoryId,
        debouncedSearchQuery,
      ),
    [categoryId, debouncedSearchQuery],
  );
  const kalshiCatalogKey = useMemo(
    () =>
      buildPredictionCatalogCacheKey("kalshi", categoryId, debouncedSearchQuery),
    [categoryId, debouncedSearchQuery],
  );
  const polymarketCatalogResourceKey = useMemo(
    () =>
      buildPredictionCatalogResourceKey(
        "polymarket",
        categoryId,
        normalizedCatalogQuery,
      ),
    [categoryId, normalizedCatalogQuery],
  );
  const kalshiCatalogResourceKey = useMemo(
    () =>
      buildPredictionCatalogResourceKey(
        "kalshi",
        categoryId,
        normalizedCatalogQuery,
      ),
    [categoryId, normalizedCatalogQuery],
  );
  const persistedPolymarketCatalog = useMemo(
    () =>
      getCachedPredictionResource<PredictionMarketSummary[]>(
        "catalog",
        polymarketCatalogResourceKey,
      ) ?? [],
    [polymarketCatalogResourceKey],
  );
  const persistedKalshiCatalog = useMemo(
    () =>
      getCachedPredictionResource<PredictionMarketSummary[]>(
        "catalog",
        kalshiCatalogResourceKey,
      ) ?? [],
    [kalshiCatalogResourceKey],
  );
  const polymarketCatalog =
    catalogCache[polymarketCatalogKey] ?? persistedPolymarketCatalog;
  const kalshiCatalog = catalogCache[kalshiCatalogKey] ?? persistedKalshiCatalog;
  activeCatalogRef.current = {
    [polymarketCatalogKey]: polymarketCatalog,
    [kalshiCatalogKey]: kalshiCatalog,
  };
  const activeCatalogKeys = useMemo(
    () =>
      [
        includePolymarket ? polymarketCatalogKey : null,
        includeKalshi ? kalshiCatalogKey : null,
      ].filter((value): value is string => value != null),
    [includeKalshi, includePolymarket, kalshiCatalogKey, polymarketCatalogKey],
  );
  const activeCatalogSources = useMemo(
    () =>
      [
        includePolymarket
          ? {
              venue: "polymarket" as const,
              cacheKey: polymarketCatalogKey,
              error: catalogErrors[polymarketCatalogKey] ?? null,
              markets: polymarketCatalog,
            }
          : null,
        includeKalshi
          ? {
              venue: "kalshi" as const,
              cacheKey: kalshiCatalogKey,
              error: catalogErrors[kalshiCatalogKey] ?? null,
              markets: kalshiCatalog,
            }
          : null,
      ].filter(
        (
          value,
        ): value is PredictionCatalogSource => value != null,
      ),
    [
      catalogErrors,
      includeKalshi,
      includePolymarket,
      kalshiCatalog,
      kalshiCatalogKey,
      polymarketCatalog,
      polymarketCatalogKey,
    ],
  );
  const catalogLoadCount = activeCatalogKeys.reduce(
    (count, cacheKey) => count + (catalogPending[cacheKey] ?? 0),
    0,
  );
  const catalogStatus = useMemo(
    () => getPredictionCatalogStatus(activeCatalogSources),
    [activeCatalogSources],
  );
  const allMarkets = useMemo(() => {
    const merged: PredictionMarketSummary[] = [];
    if (includePolymarket) merged.push(...polymarketCatalog);
    if (includeKalshi) merged.push(...kalshiCatalog);
    return merged;
  }, [includeKalshi, includePolymarket, kalshiCatalog, polymarketCatalog]);

  const loadPolymarket = useCallback(
    async (
      cacheKey: string,
      search: string,
      category: PredictionCategoryId,
      options?: { showPending?: boolean },
    ) => {
      const showPending =
        options?.showPending ??
        (search.trim().length > 0 ||
          (activeCatalogRef.current[cacheKey]?.length ?? 0) === 0);
      if (showPending) {
        setCatalogPending((current) =>
          updatePredictionPendingCounts(current, cacheKey, 1),
        );
      }
      try {
        const next = await loadPolymarketCatalog(search, category);
        setCatalogCache((current) => {
          const previous = current[cacheKey] ?? activeCatalogRef.current[cacheKey];
          if (samePredictionCatalogSummaries(previous, next)) {
            return current;
          }
          return {
            ...current,
            [cacheKey]: next,
          };
        });
        setCatalogErrors((current) =>
          updatePredictionErrorState(current, cacheKey, null),
        );
        setPolymarketNextOffset(nextPolymarketCatalogOffset(category, search));
      } catch (error) {
        setCatalogErrors((current) =>
          updatePredictionErrorState(
            current,
            cacheKey,
            formatPredictionLoadError("polymarket", "markets", error),
          ),
        );
      } finally {
        setPolymarketLoadedAt(Date.now());
        if (showPending) {
          setCatalogPending((current) =>
            updatePredictionPendingCounts(current, cacheKey, -1),
          );
        }
      }
    },
    [],
  );

  const loadKalshi = useCallback(
    async (
      cacheKey: string,
      search: string,
      category: PredictionCategoryId,
      options?: { showPending?: boolean },
    ) => {
      const showPending =
        options?.showPending ??
        (search.trim().length > 0 ||
          (activeCatalogRef.current[cacheKey]?.length ?? 0) === 0);
      if (showPending) {
        setCatalogPending((current) =>
          updatePredictionPendingCounts(current, cacheKey, 1),
        );
      }
      try {
        const next = await loadKalshiCatalog(search, category);
        setCatalogCache((current) => {
          const previous = current[cacheKey] ?? activeCatalogRef.current[cacheKey];
          if (samePredictionCatalogSummaries(previous, next)) {
            return current;
          }
          return {
            ...current,
            [cacheKey]: next,
          };
        });
        setCatalogErrors((current) =>
          updatePredictionErrorState(current, cacheKey, null),
        );
        setKalshiNextCursor(kalshiCatalogCursor(search, category));
      } catch (error) {
        setCatalogErrors((current) =>
          updatePredictionErrorState(
            current,
            cacheKey,
            formatPredictionLoadError("kalshi", "markets", error),
          ),
        );
      } finally {
        setKalshiLoadedAt(Date.now());
        if (showPending) {
          setCatalogPending((current) =>
            updatePredictionPendingCounts(current, cacheKey, -1),
          );
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedSearchQuery("");
      return;
    }
    const timeoutId = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 250);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // Reloads follow the one refresh cadence the user configured, instead of two
  // hardcoded intervals nobody can change.
  useEffect(() => {
    if (!includePolymarket) return;
    void loadPolymarket(
      polymarketCatalogKey,
      debouncedSearchQuery,
      categoryId,
    );
  }, [
    categoryId,
    debouncedSearchQuery,
    includePolymarket,
    loadPolymarket,
    polymarketCatalogKey,
  ]);

  useAutoRefresh(includePolymarket ? polymarketLoadedAt : null, useCallback(() => {
    void loadPolymarket(polymarketCatalogKey, debouncedSearchQuery, categoryId);
  }, [categoryId, debouncedSearchQuery, loadPolymarket, polymarketCatalogKey]));

  useEffect(() => {
    if (!includeKalshi) return;
    void loadKalshi(kalshiCatalogKey, debouncedSearchQuery, categoryId);
  }, [
    categoryId,
    debouncedSearchQuery,
    includeKalshi,
    kalshiCatalogKey,
    loadKalshi,
  ]);

  useAutoRefresh(includeKalshi ? kalshiLoadedAt : null, useCallback(() => {
    void loadKalshi(kalshiCatalogKey, debouncedSearchQuery, categoryId);
  }, [categoryId, debouncedSearchQuery, kalshiCatalogKey, loadKalshi]));

  const loadMoreCatalog = useCallback(async () => {
    if (loadingMore) return;
    const canLoadPolymarket = includePolymarket && polymarketNextOffset != null;
    const canLoadKalshi = includeKalshi && !!kalshiNextCursor;
    if (!canLoadPolymarket && !canLoadKalshi) return;
    setLoadingMore(true);
    try {
      if (canLoadPolymarket && polymarketNextOffset != null) {
        const page = await loadMorePolymarketCatalog(
          debouncedSearchQuery,
          categoryId,
          polymarketNextOffset,
        );
        setCatalogCache((current) => ({
          ...current,
          [polymarketCatalogKey]: mergeCatalogMarkets(
            current[polymarketCatalogKey] ?? activeCatalogRef.current[polymarketCatalogKey] ?? [],
            page.markets,
          ),
        }));
        setPolymarketNextOffset(page.hasMore ? page.nextOffset : null);
      }
      if (canLoadKalshi && kalshiNextCursor) {
        const page = await loadMoreKalshiCatalog(
          debouncedSearchQuery,
          categoryId,
          kalshiNextCursor,
        );
        setCatalogCache((current) => ({
          ...current,
          [kalshiCatalogKey]: mergeCatalogMarkets(
            current[kalshiCatalogKey] ?? activeCatalogRef.current[kalshiCatalogKey] ?? [],
            page.markets,
          ),
        }));
        setKalshiNextCursor(page.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [
    categoryId,
    debouncedSearchQuery,
    includeKalshi,
    includePolymarket,
    kalshiCatalogKey,
    kalshiNextCursor,
    loadingMore,
    polymarketCatalogKey,
    polymarketNextOffset,
  ]);

  return {
    allMarkets,
    catalogHasMore: (includePolymarket && polymarketNextOffset != null) || (includeKalshi && !!kalshiNextCursor),
    catalogLoadCount,
    catalogLoadingMore: loadingMore,
    catalogStatus,
    debouncedSearchQuery,
    loadMoreCatalog,
    setCatalogCache,
  };
}

function mergeCatalogMarkets(
  current: PredictionMarketSummary[],
  extra: PredictionMarketSummary[],
): PredictionMarketSummary[] {
  if (extra.length === 0) return current;
  const seen = new Set(current.map((market) => market.key));
  const merged = [...current];
  for (const market of extra) {
    if (seen.has(market.key)) continue;
    seen.add(market.key);
    merged.push(market);
  }
  return merged;
}
