import { useCallback } from "react";
import { Box } from "../../../../../ui";
import type { NewsArticle, NewsQuery } from "../../../../../news/types";
import { useLoadNewsStory, useNewsArticles, useNewsTableLoadMore } from "../../../../../news/hooks";
import type { PaneProps } from "../../../../../types/plugin";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../../../runtime";
import { PaneStatusBody, QueryBar, type QueryBarSearch } from "../../../../../components";
import { NewsDetailView, useNewsArticleDetail } from "./detail-view";
import {
  NewsArticleStackView,
  type NewsColumnId,
  type NewsSortPreference,
} from "./table";
import { useNewsArticleFooter } from "./footer";
import { useNewsReadState } from "../read-state";
import { usePersistedNewsArticles } from "../persisted-articles";
import { newsListEmptyCopy } from "../filter-articles";
import { NEWS_LIST_SEARCH_PLACEHOLDER, useNewsListSearch, useNewsListSearchHint } from "./list-search";
import { newsMutesApplyToFeed, useNewsMuteFilter } from "../mutes";
import { usePopOutNewsArticle } from "./pop-out";

interface NewsArticleStackOptions {
  /** Prefix of every key the pane persists, and of its footer registration. */
  paneKey: string;
  articles: NewsArticle[];
  focused: boolean;
  width: number;
  columns: NewsColumnId[];
  defaultSort: NewsSortPreference;
  /** Rows stay on screen while a refresh runs, so the footer says it is loading. */
  refreshing: boolean;
  error: string | null;
}

/**
 * Selection, sort, the open story, read state and the footer of a wire pane,
 * as the props its NewsArticleStackView needs.
 */
export function useNewsArticleStack({
  paneKey,
  articles,
  focused,
  width,
  columns,
  defaultSort,
  refreshing,
  error,
}: NewsArticleStackOptions) {
  const [selectedArticleId, setSelectedArticleId] = useDebouncedPluginPaneState<string | null>(
    `${paneKey}:selectedArticleId`,
    null,
  );
  const [sortPreference, setSortPreference] = usePluginPaneState<NewsSortPreference>(
    `${paneKey}:sort`,
    defaultSort,
  );
  const search = useNewsListSearch(articles);
  const visibleArticles = search.filteredArticles;
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, detailLoading, detailError, openArticle, closeDetail } = useNewsArticleDetail(
    visibleArticles,
    loadNewsStory,
    `${paneKey}:openArticleId`,
  );
  const { readArticleIds, markArticleRead } = useNewsReadState();
  const detailOpen = !!detailArticle;
  const listFocused = focused && !search.searchFocused;
  const readableArticle = detailArticle
    ?? visibleArticles.find((article) => article.id === selectedArticleId)
    ?? null;
  const popOutArticle = usePopOutNewsArticle(closeDetail);
  const popOutReadable = useCallback(() => {
    if (!readableArticle) return;
    markArticleRead(readableArticle.id);
    popOutArticle(readableArticle);
  }, [markArticleRead, popOutArticle, readableArticle]);
  const openListedArticle = useCallback((article: NewsArticle) => {
    search.blurSearch();
    openArticle(article);
  }, [openArticle, search.blurSearch]);
  const searchBar: QueryBarSearch = {
    value: search.searchQuery,
    onChange: search.setSearchQuery,
    placeholder: NEWS_LIST_SEARCH_PLACEHOLDER,
    focused: focused && !detailOpen,
    ...search.searchProps,
  };

  useNewsListSearchHint(`news-wire:${paneKey}`, focused && !detailOpen, search.focusSearch);
  useNewsArticleFooter({
    registrationId: `news-wire:${paneKey}`,
    focused: listFocused,
    article: detailArticle,
    loading: detailLoading || refreshing,
    error: [error, detailError].filter(Boolean).join(" ") || null,
    onPopOut: readableArticle ? popOutReadable : undefined,
  });

  return {
    articles: visibleArticles,
    focused: listFocused,
    width,
    columns,
    readArticleIds,
    selectedArticleId,
    setSelectedArticleId,
    sortPreference: columns.includes(sortPreference.columnId) ? sortPreference : defaultSort,
    setSortPreference,
    onOpenArticle: openListedArticle,
    onArticleRead: markArticleRead,
    detailOpen,
    onBack: closeDetail,
    detailContent: detailArticle ? (
      <NewsDetailView
        item={detailArticle}
        focused={listFocused}
        width={width}
        showTitle={false}
      />
    ) : (
      <Box flexGrow={1} />
    ),
    detailTitle: detailArticle?.title,
    search: searchBar,
    searchQuery: search.searchQuery,
  };
}

export interface NewsPresetPaneConfig {
  paneKey: string;
  title: string;
  query: NewsQuery;
  columns: NewsColumnId[];
  defaultSort: NewsSortPreference;
  emptyStateTitle: string;
  emptyStateHint: string;
}

export function NewsPresetPane({
  focused,
  width,
  height,
  paneKey,
  title,
  query,
  columns,
  defaultSort,
  emptyStateTitle,
  emptyStateHint,
}: PaneProps & NewsPresetPaneConfig) {
  const newsState = useNewsArticles(query);
  const persisted = usePersistedNewsArticles(`${paneKey}:articles`, newsState.articles);
  const articles = useNewsMuteFilter(persisted, newsMutesApplyToFeed(query.feed));
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(query, newsState);
  // The aggregator opens a query in "loading", so the first paint is a loading
  // body rather than a definitive empty wire.
  const loading = newsState.phase === "loading"
    || (newsState.phase === "refreshing" && persisted.length === 0);
  const error = newsState.error;
  const { search, searchQuery, ...stack } = useNewsArticleStack({
    paneKey,
    articles,
    focused,
    width,
    columns,
    defaultSort,
    refreshing: loading && persisted.length > 0,
    error,
  });
  const emptyCopy = newsListEmptyCopy({
    query: searchQuery,
    loadedCount: persisted.length,
    unmutedCount: articles.length,
    fallback: { title: emptyStateTitle, hint: emptyStateHint },
  });

  return (
    <NewsArticleStackView
      {...stack}
      rootHeight={height}
      rootBefore={(
        <QueryBar
          width={width}
          search={search}
        />
      )}
      emptyContent={(
        <PaneStatusBody
          loading={loading}
          error={error}
          empty
          subject={title}
          emptyTitle={emptyCopy.title}
          emptyMessage={emptyCopy.hint}
        />
      )}
      emptyStateTitle={emptyCopy.title}
      emptyStateHint={emptyCopy.hint}
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
    />
  );
}

export function createNewsPresetPane(config: NewsPresetPaneConfig) {
  return function PresetNewsPane(props: PaneProps) {
    return <NewsPresetPane {...props} {...config} />;
  };
}
