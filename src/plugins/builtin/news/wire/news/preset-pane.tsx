import { Box } from "../../../../../ui";
import type { NewsQuery } from "../../../../../news/types";
import { useLoadNewsStory, useNewsArticles } from "../../../../../news/hooks";
import type { PaneProps } from "../../../../../types/plugin";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../../../runtime";
import { NewsDetailView, useNewsArticleDetail } from "./detail-view";
import {
  NewsArticleStackView,
  newsTableStatusContent,
  type NewsColumnId,
  type NewsSortPreference,
} from "./table";
import { useNewsArticleFooter } from "./footer";
import { useNewsReadState } from "../read-state";
import { usePersistedNewsArticles } from "../persisted-articles";

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
}: PaneProps & {
  paneKey: string;
  title: string;
  query: NewsQuery;
  columns: NewsColumnId[];
  defaultSort: NewsSortPreference;
  emptyStateTitle: string;
  emptyStateHint: string;
}) {
  const newsState = useNewsArticles(query);
  const articles = usePersistedNewsArticles(`${paneKey}:articles`, newsState.articles);
  // The aggregator opens a query in "loading", so the first paint is a loading
  // body rather than a definitive empty wire.
  const loading = newsState.phase === "loading"
    || (newsState.phase === "refreshing" && articles.length === 0);
  const error = newsState.error;
  const [selectedArticleId, setSelectedArticleId] = useDebouncedPluginPaneState<string | null>(
    `${paneKey}:selectedArticleId`,
    null,
  );
  const [sortPreference, setSortPreference] = usePluginPaneState<NewsSortPreference>(
    `${paneKey}:sort`,
    defaultSort,
  );
  const effectiveSortPreference = columns.includes(sortPreference.columnId)
    ? sortPreference
    : defaultSort;
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, openArticle, closeDetail } = useNewsArticleDetail(articles, loadNewsStory);
  const { readArticleIds, markArticleRead } = useNewsReadState();

  useNewsArticleFooter({
    registrationId: `news-wire:${paneKey}`,
    focused,
    article: detailArticle,
    loading: loading && articles.length > 0,
    error,
  });

  const detailContent = detailArticle ? (
    <NewsDetailView
      item={detailArticle}
      focused={focused}
      width={width}
      showTitle={false}
    />
  ) : (
    <Box flexGrow={1} />
  );

  return (
    <NewsArticleStackView
      articles={articles}
      focused={focused}
      width={width}
      rootHeight={height}
      readArticleIds={readArticleIds}
      selectedArticleId={selectedArticleId}
      setSelectedArticleId={setSelectedArticleId}
      sortPreference={effectiveSortPreference}
      setSortPreference={setSortPreference}
      onOpenArticle={openArticle}
      onArticleRead={markArticleRead}
      detailOpen={!!detailArticle}
      onBack={closeDetail}
      detailContent={detailContent}
      detailTitle={detailArticle?.title}
      columns={columns}
      emptyContent={newsTableStatusContent({
        loading,
        error,
        subject: title,
        emptyTitle: emptyStateTitle,
        emptyMessage: emptyStateHint,
      })}
      emptyStateTitle={emptyStateTitle}
      emptyStateHint={emptyStateHint}
    />
  );
}
