import { Box } from "../../../../ui";
import { useEffect, useMemo } from "react";
import type { PaneProps } from "../../../../types/plugin";
import type { MarketNewsItem } from "../../../../types/news-source";
import { useNewsArticles, useNewsTableLoadMore } from "../../../../news/hooks";
import { usePluginPaneState } from "../../../runtime";
import { PaneStatusBody, usePaneTabs } from "../../../../components";
import { useNewsArticleStack } from "./news/preset-pane";
import {
  NewsArticleStackView,
  type NewsColumnId,
  type NewsSortPreference,
} from "./news/table";
import { usePersistedNewsArticles } from "./persisted-articles";
import {
  NEWS_QUERY_PRESETS,
  SECTOR_NEWS_SECTORS,
  type SectorNewsSelection,
  sectorNewsLabel,
} from "./news/query-presets";

const SECTOR_TABS = ["all", ...SECTOR_NEWS_SECTORS] as const;

const DEFAULT_SORT: NewsSortPreference = { columnId: "time", direction: "desc" };
const COLUMNS: NewsColumnId[] = ["time", "source", "title", "tickers", "categories", "sentiment"];

/**
 * Every sector tab filters the one all-sector response instead of issuing a
 * second request for a slice of the same stories.
 */
function useIndustryArticles(sector: SectorNewsSelection): {
  articles: MarketNewsItem[];
  allArticles: MarketNewsItem[];
  loading: boolean;
  error: string | null;
  newsState: ReturnType<typeof useNewsArticles>;
} {
  const allState = useNewsArticles(NEWS_QUERY_PRESETS.sectorAll);
  const allArticles = usePersistedNewsArticles("industry:sector:all:articles", allState.articles);
  const articles = useMemo(() => (
    sector === "all"
      ? allArticles
      : allArticles.filter((article) => (
        article.sectors.some((entry) => entry.toLowerCase() === sector)
      ))
  ), [allArticles, sector]);
  return {
    articles,
    allArticles,
    loading: allState.phase === "loading"
      || (allState.phase === "refreshing" && allArticles.length === 0),
    error: allState.error,
    newsState: allState,
  };
}

export function IndustryPane({ focused, width, height }: PaneProps) {
  const [category, setCategory] = usePluginPaneState<SectorNewsSelection>("industry:category", "all");
  const { articles, allArticles, loading, error, newsState } = useIndustryArticles(category);
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(NEWS_QUERY_PRESETS.sectorAll, newsState);
  const stack = useNewsArticleStack({
    paneKey: "industry",
    articles,
    focused,
    width,
    columns: COLUMNS,
    defaultSort: DEFAULT_SORT,
    refreshing: loading && allArticles.length > 0,
    error,
  });
  const { setSelectedArticleId, detailOpen } = stack;
  const tabs = useMemo(() => SECTOR_TABS.map((cat) => ({
    value: cat,
    label: sectorNewsLabel(cat),
  })), []);

  useEffect(() => {
    setSelectedArticleId(null);
  }, [category, setSelectedArticleId]);

  const selectCategory = (value: string) => setCategory(value as SectorNewsSelection);
  // An open story owns h/l and the arrows; the sector strip must not switch under it.
  const tabsFocused = focused && !detailOpen;
  const { strip: tabStrip } = usePaneTabs({
    tabs, activeValue: category, onSelect: selectCategory, focused: tabsFocused, compact: true, variant: "bare",
  });
  const rootBefore = tabStrip ? <Box height={1} flexShrink={0} overflow="hidden">{tabStrip}</Box> : undefined;

  return (
    <NewsArticleStackView
      {...stack}
      rootHeight={height}
      rootBefore={rootBefore}
      emptyContent={(
        <PaneStatusBody
          loading={loading}
          error={error}
          empty
          subject="Sector news"
          emptyTitle="No news in this category"
          emptyMessage="Try another category or wait for the next feed refresh."
        />
      )}
      emptyStateTitle="No news in this category"
      emptyStateHint="Try another category or wait for the next feed refresh."
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
    />
  );
}
