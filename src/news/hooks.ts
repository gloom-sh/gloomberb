import { useCallback, useRef, useSyncExternalStore } from "react";
import { buildNewsQueryKey, type NewsService } from "./aggregator";
import type { NewsArticle, NewsQuery, NewsQueryState } from "./types";
import { useTableLoadMore } from "../components/table-view-shared";
import type { ScrollBoxRenderable } from "../ui";

let sharedService: NewsService | null = null;

export function setSharedNewsService(service: NewsService | null): void {
  sharedService = service;
}

export function getSharedNewsService(): NewsService | null {
  return sharedService;
}

const IDLE_NEWS_QUERY_STATE: NewsQueryState = {
  phase: "idle",
  articles: [],
  error: null,
  updatedAt: null,
  sourceIds: [],
  nextCursor: null,
  loadingMore: false,
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

export function useNewsLoadMore(query: NewsQuery | null | undefined): () => void {
  const key = query ? buildNewsQueryKey(query) : null;
  return useCallback(() => {
    if (!query) return;
    void sharedService?.loadMore(query);
  }, [key]);
}

export function useNewsTableLoadMore(
  query: NewsQuery | null | undefined,
  state: Pick<NewsQueryState, "nextCursor" | "loadingMore">,
) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useNewsLoadMore(query);
  const onBodyScrollActivity = useTableLoadMore(
    scrollRef,
    !!state.nextCursor && !state.loadingMore,
    loadMore,
  );
  return { scrollRef, onBodyScrollActivity };
}
