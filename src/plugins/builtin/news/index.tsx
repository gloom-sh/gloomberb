import { Box } from "../../../ui";
import { composeBuiltinPlugin, type PluginModule } from "../plugin-module";
import { usePaneTicker } from "../../../state/app/context";
import { useArticleSummary, useResolvedEntryValue } from "../../../market-data/hooks";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { EmptyState } from "../../../components";
import { useLoadNewsStory, useNewsArticles, useNewsTableLoadMore } from "../../../news/hooks";
import { newsWireModule } from "./wire";
import { NewsDetailView, useNewsArticleDetail } from "./wire/news/detail-view";
import {
  NewsArticleStackView,
  newsTableStatusContent,
  type NewsSortPreference,
} from "./wire/news/table";
import { useNewsArticleFooter } from "./wire/news/footer";
import { usePersistedNewsArticles } from "./wire/persisted-articles";
import { useNewsReadState } from "./wire/read-state";
import { createTickerSurfacePaneTemplate } from "../shared/ticker-surface";

const NEWS_ITEM_LIMIT = 50;
const DEFAULT_SORT: NewsSortPreference = { columnId: "time", direction: "desc" };

function TickerNewsView({ width, height, focused }: { width: number; height: number; focused: boolean }) {
  const { ticker } = usePaneTicker();
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
  const news = usePersistedNewsArticles(
    `articles:${instrument?.symbol ?? "none"}:${instrument?.exchange ?? ""}`,
    newsState.articles,
  );
  const { readArticleIds, markArticleRead } = useNewsReadState();
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(newsQuery, newsState);
  const loadNewsStory = useLoadNewsStory();
  const { detailArticle, openArticle, closeDetail } = useNewsArticleDetail(news, loadNewsStory);
  const loading = newsState.phase === "loading"
    || (newsState.phase === "refreshing" && news.length === 0);
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

  useNewsArticleFooter({
    registrationId: "news",
    focused,
    article: detailArticle,
    // Stale rows stay on screen during a refresh or a failure, so the pane says
    // so in the footer instead of replacing them.
    loading: loading && news.length > 0,
    error,
    info: loadingSummary
      ? [{ id: "summary", parts: [{ text: "summary loading", tone: "muted" as const }] }]
      : undefined,
  });

  if (!ticker) {
    return (
      <Box paddingX={1} paddingY={1}>
        <EmptyState title="No ticker selected." message="Pick a ticker to load its news." />
      </Box>
    );
  }

  return (
    <NewsArticleStackView
      articles={news}
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
      detailOpen={!!detailWithSummary}
      onBack={closeDetail}
      detailContent={detailWithSummary ? (
        <NewsDetailView
          item={detailWithSummary}
          focused={focused}
          width={width}
          showTitle={false}
        />
      ) : (
        <Box flexGrow={1} />
      )}
      detailTitle={detailWithSummary?.title}
      columns={["time", "source", "title", "categories", "sentiment"]}
      emptyContent={newsTableStatusContent({
        loading,
        error,
        subject: "News",
        emptyTitle: `No news for ${ticker.metadata.ticker}`,
        emptyMessage: "Stories appear as sources publish them.",
      })}
      emptyStateTitle={`No news for ${ticker.metadata.ticker}`}
      emptyStateHint="Stories appear as sources publish them."
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
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 32 },
    },
  ],

  paneTemplates: [
    createTickerSurfacePaneTemplate({
      id: "ticker-news-pane",
      paneId: "ticker-news",
      label: "Ticker News",
      description: "Company news for the selected ticker.",
      keywords: ["company", "ticker", "news", "headlines", "cn"],
      shortcut: "CN",
      publicShare: true,
    }),
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
  id: "news",
  name: "News",
  version: "1.0.0",
  description: "View latest news for each ticker",
  toggleable: true,
  modules: [tickerNewsModule, newsWireModule],
});
