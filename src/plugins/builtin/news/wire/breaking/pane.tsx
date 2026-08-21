import { Box } from "../../../../../ui";
import type { PaneProps } from "../../../../../types/plugin";
import { useLoadNewsStory, useNewsArticles, useNewsTableLoadMore } from "../../../../../news/hooks";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../../../runtime";
import { NewsDetailView, useNewsArticleDetail } from "../news/detail-view";
import {
  NewsArticleStackView,
  newsTableStatusContent,
  type NewsSortPreference,
} from "../news/table";
import { useNewsArticleFooter } from "../news/footer";
import { NEWS_QUERY_PRESETS } from "../news/query-presets";
import { usePersistedNewsArticles } from "../persisted-articles";
import { useNewsReadState } from "../read-state";

const DEFAULT_SORT: NewsSortPreference = { columnId: "importance", direction: "desc" };

export function BreakingPane({ focused, width, height }: PaneProps) {
  const breakingState = useNewsArticles(NEWS_QUERY_PRESETS.breaking);
  const articles = usePersistedNewsArticles("breaking:articles", breakingState.articles);
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(NEWS_QUERY_PRESETS.breaking, breakingState);
  const loading = breakingState.phase === "loading"
    || (breakingState.phase === "refreshing" && articles.length === 0);
  const error = breakingState.error;
  const [selectedArticleId, setSelectedArticleId] = useDebouncedPluginPaneState<string | null>("breaking:selectedArticleId", null);
  const [sortPreference, setSortPreference] = usePluginPaneState<NewsSortPreference>("breaking:sort", DEFAULT_SORT);
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, openArticle, closeDetail } = useNewsArticleDetail(articles, loadNewsStory);
  const { readArticleIds, markArticleRead } = useNewsReadState();

  useNewsArticleFooter({
    registrationId: "news-wire:breaking",
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
      sortPreference={sortPreference}
      setSortPreference={setSortPreference}
      onOpenArticle={openArticle}
      onArticleRead={markArticleRead}
      detailOpen={!!detailArticle}
      onBack={closeDetail}
      detailContent={detailContent}
      detailTitle={detailArticle?.title}
      columns={["time", "source", "title", "tickers", "categories", "importance"]}
      emptyContent={newsTableStatusContent({
        loading,
        error,
        subject: "Breaking news",
        emptyTitle: "No breaking news",
        emptyMessage: "Breaking stories appear when high-priority headlines arrive.",
      })}
      emptyStateTitle="No breaking news"
      emptyStateHint="Breaking stories appear when high-priority headlines arrive."
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
    />
  );
}
