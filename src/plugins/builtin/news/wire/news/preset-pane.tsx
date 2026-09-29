import { Box } from "../../../../../ui";
import type { NewsQuery } from "../../../../../news/types";
import { useLoadNewsStory, useNewsArticles, useNewsTableLoadMore } from "../../../../../news/hooks";
import type { MarketNewsItem } from "../../../../../types/news-source";
import type { PaneProps } from "../../../../../types/plugin";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../../../runtime";
import { PaneStatusBody } from "../../../../../components";
import { NewsDetailView, useNewsArticleDetail } from "./detail-view";
import {
  NewsArticleStackView,
  type NewsColumnId,
  type NewsSortPreference,
} from "./table";
import { useNewsArticleFooter } from "./footer";
import { useNewsReadState } from "../read-state";
import { usePersistedNewsArticles } from "../persisted-articles";

interface NewsArticleStackOptions {
  /** Prefix of every key the pane persists, and of its footer registration. */
  paneKey: string;
  articles: MarketNewsItem[];
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
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, detailLoading, detailError, openArticle, closeDetail } = useNewsArticleDetail(
    articles,
    loadNewsStory,
    `${paneKey}:openArticleId`,
  );
  const { readArticleIds, markArticleRead } = useNewsReadState();

  useNewsArticleFooter({
    registrationId: `news-wire:${paneKey}`,
    focused,
    article: detailArticle,
    loading: detailLoading || refreshing,
    error: [error, detailError].filter(Boolean).join(" ") || null,
  });

  return {
    articles,
    focused,
    width,
    columns,
    readArticleIds,
    selectedArticleId,
    setSelectedArticleId,
    sortPreference: columns.includes(sortPreference.columnId) ? sortPreference : defaultSort,
    setSortPreference,
    onOpenArticle: openArticle,
    onArticleRead: markArticleRead,
    detailOpen: !!detailArticle,
    onBack: closeDetail,
    detailContent: detailArticle ? (
      <NewsDetailView
        item={detailArticle}
        focused={focused}
        width={width}
        showTitle={false}
      />
    ) : (
      <Box flexGrow={1} />
    ),
    detailTitle: detailArticle?.title,
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
  const articles = usePersistedNewsArticles(`${paneKey}:articles`, newsState.articles);
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(query, newsState);
  // The aggregator opens a query in "loading", so the first paint is a loading
  // body rather than a definitive empty wire.
  const loading = newsState.phase === "loading"
    || (newsState.phase === "refreshing" && articles.length === 0);
  const error = newsState.error;
  const stack = useNewsArticleStack({
    paneKey,
    articles,
    focused,
    width,
    columns,
    defaultSort,
    refreshing: loading && articles.length > 0,
    error,
  });

  return (
    <NewsArticleStackView
      {...stack}
      rootHeight={height}
      emptyContent={(
        <PaneStatusBody
          loading={loading}
          error={error}
          empty
          subject={title}
          emptyTitle={emptyStateTitle}
          emptyMessage={emptyStateHint}
        />
      )}
      emptyStateTitle={emptyStateTitle}
      emptyStateHint={emptyStateHint}
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
