import { useCallback, useSyncExternalStore } from "react";
import { buildNewsQueryKey, type NewsService } from "./aggregator";
import type { NewsArticle, NewsQuery, NewsQueryState } from "./types";

let sharedService: NewsService | null = null;

export function setSharedNewsService(service: NewsService | null): void {
  sharedService = service;
}

const IDLE_NEWS_QUERY_STATE: NewsQueryState = {
  phase: "idle",
  articles: [],
  error: null,
  updatedAt: null,
  sourceIds: [],
};

export function useNewsArticles(query: NewsQuery | null | undefined): NewsQueryState {
  const service = sharedService;
  const key = query ? buildNewsQueryKey(query) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!query || !service) return () => {};
    return service.watchQuery(query, () => listener());
  }, [key, service]);
  const getSnapshot = useCallback(
    () => query && service ? service.getQueryState(query) : IDLE_NEWS_QUERY_STATE,
    [key, service],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useLoadNewsStory(): (storyId: string) => Promise<NewsArticle | null> {
  return useCallback(async (storyId: string) => sharedService?.loadStory(storyId) ?? null, []);
}
