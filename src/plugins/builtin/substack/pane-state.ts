import { formatTimeAgo } from "../../../utils/format";
import {
  getCachedSubstackArticleDetail,
  getCachedSubstackHome,
  getCachedSubstackPublicationFeed,
} from "./api/cache";
import type {
  SubstackHomeData,
  SubstackPublicationFeedPage,
} from "./api/types";
import { articleMatchesPublication } from "./normalize";
import type {
  SubstackArticleDetail,
  SubstackArticleSummary,
  SubstackPublication,
} from "./types";

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  stale: boolean;
}

export type PublicationFeedState = LoadState<SubstackPublicationFeedPage> & {
  loadingMore: boolean;
};

export type DetailState = LoadState<SubstackArticleDetail>;

export type ActiveFeedState = LoadState<SubstackArticleSummary[]> & {
  loadingMore?: boolean;
  hasMore?: boolean;
  nextOffset?: number | null;
};

export function emptyLoadState<T>(): LoadState<T> {
  return {
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    stale: false,
  };
}

export function emptyPublicationFeedState(): PublicationFeedState {
  return {
    ...emptyLoadState<SubstackPublicationFeedPage>(),
    loadingMore: false,
  };
}

export function mergePublicationFeedPages(
  current: SubstackPublicationFeedPage | null,
  next: SubstackPublicationFeedPage,
): SubstackPublicationFeedPage {
  if (!current) return next;
  const articlesById = new Map<string, SubstackArticleSummary>();
  for (const article of current.items) articlesById.set(article.id, article);
  for (const article of next.items) articlesById.set(article.id, article);
  return {
    items: [...articlesById.values()],
    nextOffset: next.nextOffset,
    hasMore: next.hasMore,
  };
}

export function homeLoadStateFromCache(): LoadState<SubstackHomeData> {
  const cached = getCachedSubstackHome();
  if (!cached) return emptyLoadState<SubstackHomeData>();
  return {
    data: cached,
    loading: false,
    error: null,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
  };
}

export function publicationLoadStateFromCache(publication: SubstackPublication): PublicationFeedState | null {
  const cached = getCachedSubstackPublicationFeed(publication);
  if (!cached) return null;
  return {
    data: cached.data,
    loading: false,
    loadingMore: false,
    error: null,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
  };
}

export function detailLoadStateFromCache(article: SubstackArticleSummary): DetailState | null {
  const cached = getCachedSubstackArticleDetail(article);
  if (!cached) return null;
  return {
    data: cached.data,
    loading: false,
    error: null,
    fetchedAt: cached.fetchedAt,
    stale: cached.stale,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function tabLabel(label: string): string {
  const compact = label.replace(/\s+/g, " ").trim();
  return compact.length <= 24 ? compact : `${compact.slice(0, 21)}...`;
}

export function cacheStatusLabel(fetchedAt: number | null, stale: boolean): string | null {
  if (!fetchedAt) return null;
  return `${stale ? "stale " : "updated "}${formatTimeAgo(new Date(fetchedAt))}`;
}

export function activeFeedStateFromSources({
  activePublication,
  activePublicationTabId,
  publicationFeeds,
  home,
}: {
  activePublication: SubstackPublication | null;
  activePublicationTabId: string | null;
  publicationFeeds: Record<string, PublicationFeedState>;
  home: LoadState<SubstackHomeData>;
}): ActiveFeedState {
  if (!activePublication || !activePublicationTabId) {
    return {
      data: home.data?.feed ?? null,
      loading: home.loading,
      error: home.error,
      fetchedAt: home.fetchedAt,
      stale: home.stale,
      loadingMore: false,
      hasMore: home.data?.hasMore === true,
      nextOffset: null,
    };
  }

  const publicationEntry = publicationFeeds[activePublicationTabId];
  if (publicationEntry?.data) {
    return {
      data: publicationEntry.data.items,
      loading: publicationEntry.loading,
      loadingMore: publicationEntry.loadingMore,
      hasMore: publicationEntry.data.hasMore,
      nextOffset: publicationEntry.data.nextOffset,
      error: publicationEntry.error,
      fetchedAt: publicationEntry.fetchedAt,
      stale: publicationEntry.stale,
    };
  }

  const publicationFallbackRows = home.data?.feed.filter((article) => articleMatchesPublication(article, activePublication)) ?? [];
  return {
    data: publicationFallbackRows.length > 0 ? publicationFallbackRows : null,
    loading: publicationEntry?.loading ?? false,
    loadingMore: publicationEntry?.loadingMore ?? false,
    hasMore: false,
    nextOffset: null,
    error: publicationEntry?.error ?? null,
    fetchedAt: publicationEntry?.fetchedAt ?? home.fetchedAt,
    stale: publicationEntry?.stale ?? home.stale,
  };
}
