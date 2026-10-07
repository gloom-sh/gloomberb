import { Box } from "../../../ui";
import { composeBuiltinPlugin, type PluginModule } from "../plugin-module";
import { newsPluginMeta } from "../builtin-plugin-meta";
import { useArticleSummary, useResolvedEntryValue } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useCallback } from "react";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { EmptyState, PaneStatusBody, QueryBar } from "../../../components";
import { newsMuteSettingsDef, newsMutesApplyToFeed, useNewsMuteFilter } from "./wire/mutes";
import { newsListEmptyCopy } from "./wire/filter-articles";
import { NEWS_LIST_SEARCH_PLACEHOLDER, useNewsListSearch, useNewsListSearchHint } from "./wire/news/list-search";
import { usePopOutNewsArticle } from "./wire/news/pop-out";
import { useLoadNewsStory, useNewsArticles, useNewsTableLoadMore } from "../../../news/hooks";
import { newsWireModule } from "./wire";
import { NewsDetailView, useNewsArticleDetail } from "./wire/news/detail-view";
import {
  NewsArticleStackView,
  type NewsSortPreference,
} from "./wire/news/table";
import { useNewsArticleFooter } from "./wire/news/footer";
import { usePersistedNewsArticles } from "./wire/persisted-articles";
import { useNewsReadState } from "./wire/read-state";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";
import { tickerNewsHeadless } from "./headless";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

const NEWS_ITEM_LIMIT = 50;
const DEFAULT_SORT: NewsSortPreference = { columnId: "time", direction: "desc" };

function TickerNewsView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = ticker?.metadata.ticker ?? "none";
  const [selectedArticleId, setSelectedArticleId] = useDebouncedPluginPaneState<string | null>(
    `selectedArticleId:${symbol}`,
    null,
  );
  const [sortPreference, setSortPreference] = usePluginPaneState<NewsSortPreference>(
    "ticker-news:sort",
    DEFAULT_SORT,
  );
  const instrument = instrumentFromTicker(ticker, ticker?.metadata.ticker ?? null);
  const newsQuery = instrument ? {
    feed: "ticker" as const,
    ticker: instrument.symbol,
    exchange: instrument.exchange,
    tickerTier: "primary" as const,
    limit: NEWS_ITEM_LIMIT,
  } : null;
  const newsState = useNewsArticles(newsQuery);
  const loaded = usePersistedNewsArticles(
    `articles:${instrument?.symbol ?? "none"}:${instrument?.exchange ?? ""}`,
    newsState.articles,
    { keyFamily: "articles:" },
  );
  const news = useNewsMuteFilter(loaded, newsMutesApplyToFeed(newsQuery?.feed));
  const search = useNewsListSearch(news);
  const visibleArticles = search.filteredArticles;
  const { readArticleIds, markArticleRead } = useNewsReadState();
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(newsQuery, newsState);
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, detailLoading, detailError, openArticle, closeDetail } = useNewsArticleDetail(
    visibleArticles,
    loadNewsStory,
    `openArticleId:${symbol}`,
  );
  const popOutArticle = usePopOutNewsArticle(closeDetail);
  const openListedArticle = useCallback((article: typeof visibleArticles[number]) => {
    search.blurSearch();
    openArticle(article);
  }, [openArticle, search.blurSearch]);
  const loading = newsState.phase === "loading"
    || (newsState.phase === "refreshing" && loaded.length === 0);
  const error = newsState.error;
  const articleSummaryEntry = useArticleSummary(
    detailArticle && !detailArticle.summary ? detailArticle.url : null,
  );
  const fetchedSummary = useResolvedEntryValue(articleSummaryEntry);
  const loadingSummary = articleSummaryEntry?.phase === "loading"
    || articleSummaryEntry?.phase === "refreshing";
  const detailWithSummary = detailArticle && !detailArticle.summary && fetchedSummary
    ? { ...detailArticle, summary: fetchedSummary }
    : detailArticle;
  const detailOpen = !!detailWithSummary;
  const listFocused = focused && !search.searchFocused;
  const selectedArticle = visibleArticles.find((article) => article.id === selectedArticleId) ?? null;
  const readableArticle = detailWithSummary ?? selectedArticle;
  const popOutReadable = useCallback(() => {
    if (!readableArticle) return;
    markArticleRead(readableArticle.id);
    popOutArticle(readableArticle);
  }, [markArticleRead, popOutArticle, readableArticle]);

  useNewsListSearchHint("ticker-news", focused && !detailOpen, search.focusSearch);
  useNewsArticleFooter({
    registrationId: "news",
    focused: listFocused,
    article: detailArticle,
    // Stale rows stay on screen during a refresh or a failure, so the pane says
    // so in the footer instead of replacing them.
    loading: detailLoading || (loading && loaded.length > 0),
    error: [error, detailError].filter(Boolean).join(" ") || null,
    info: loadingSummary
      ? [{ id: "summary", parts: [{ text: "summary loading", tone: "muted" as const }] }]
      : undefined,
    onPopOut: readableArticle ? popOutReadable : undefined,
  });

  if (!ticker) {
    return (
      <Box paddingX={1} paddingY={1}>
        <EmptyState title="No ticker selected." message="Pick a ticker to load its news." />
      </Box>
    );
  }

  const emptyCopy = newsListEmptyCopy({
    query: search.searchQuery,
    loadedCount: loaded.length,
    unmutedCount: news.length,
    fallback: {
      title: `No news for ${ticker.metadata.ticker}`,
      hint: "Stories appear as sources publish them.",
    },
  });

  return (
    <NewsArticleStackView
      articles={visibleArticles}
      focused={listFocused}
      width={width}
      rootHeight={height}
      readArticleIds={readArticleIds}
      selectedArticleId={selectedArticleId}
      setSelectedArticleId={setSelectedArticleId}
      sortPreference={sortPreference}
      setSortPreference={setSortPreference}
      onOpenArticle={openListedArticle}
      onArticleRead={markArticleRead}
      detailOpen={detailOpen}
      onBack={closeDetail}
      detailContent={detailWithSummary ? (
        <NewsDetailView
          item={detailWithSummary}
          focused={listFocused}
          width={width}
          showTitle={false}
        />
      ) : (
        <Box flexGrow={1} />
      )}
      detailTitle={detailWithSummary?.title}
      columns={["time", "source", "title", "categories", "sentiment"]}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: search.searchQuery,
            onChange: search.setSearchQuery,
            placeholder: NEWS_LIST_SEARCH_PLACEHOLDER,
            focused: focused && !detailOpen,
            ...search.searchProps,
          }}
        />
      )}
      emptyContent={(
        <PaneStatusBody
          loading={loading}
          error={error}
          empty
          subject="News"
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

export const tickerNewsModule: PluginModule = {
  panes: [
    {
      id: "ticker-news",
      name: "Ticker News",
      icon: "C",
      component: TickerNewsView,
      defaultPosition: "right",
      tickerFollower: true,
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
      settings: (context) => newsMuteSettingsDef(context, "Ticker News Settings"),
    },
  ],

  paneTemplates: [
    {
      ...createTickerSurfacePaneTemplate({
        id: "ticker-news-pane",
        paneId: "ticker-news",
        label: "Ticker News",
        description: "Company news for the selected ticker.",
        keywords: ["company", "ticker", "news", "headlines", "cn"],
        shortcut: "CN",
        publicShare: true,
      }),
      headless: tickerNewsHeadless,
    },
  ],

  setup(ctx) {
    ctx.registerTickerResearchTab({
      id: "news",
      name: "News",
      order: 40,
      component: TickerNewsView,
    });
  },
};

export const newsPlugin = composeBuiltinPlugin({
  ...newsPluginMeta,
  modules: [tickerNewsModule, newsWireModule],
});
