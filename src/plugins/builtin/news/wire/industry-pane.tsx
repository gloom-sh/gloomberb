import { useEffect, useMemo } from "react";
import type { PaneProps } from "../../../../types/plugin";
import type { MarketNewsItem } from "../../../../types/news-source";
import type { NewsQuery } from "../../../../news/types";
import { useNewsArticles, useNewsTableLoadMore } from "../../../../news/hooks";
import { usePluginPaneState } from "../../../runtime";
import { PaneStatusBody, QueryBar, type SelectButtonOption } from "../../../../components";
import { usePaneInstance, usePaneTitle } from "../../../../state/app/context";
import { useNewsArticleStack } from "./news/preset-pane";
import {
  NewsArticleStackView,
  type NewsColumnId,
  type NewsSortPreference,
} from "./news/table";
import { usePersistedNewsArticles } from "./persisted-articles";
import {
  NEWS_INDUSTRY_CODES,
  NEWS_QUERY_PRESETS,
  type NewsIndustryCode,
  parseNewsIndustryCode,
} from "./news/query-presets";

export const TOPIC_NEWS_TITLE = "Topic News";

const DEFAULT_SORT: NewsSortPreference = { columnId: "time", direction: "desc" };
const COLUMNS: NewsColumnId[] = ["time", "source", "title", "tickers", "categories", "sentiment"];
const VALID_CODES = NEWS_INDUSTRY_CODES.filter((entry) => entry.code !== "ALL")
  .map((entry) => entry.code)
  .join(" ");
// The title carries the code (NI MNA), so the control names the topic.
const CODE_OPTIONS: SelectButtonOption[] = NEWS_INDUSTRY_CODES.map((entry) => ({
  value: entry.code,
  label: entry.label,
  description: entry.code === "ALL" ? undefined : entry.code,
}));

interface IndustryArticles {
  articles: MarketNewsItem[];
  loading: boolean;
  error: string | null;
  query: NewsQuery | null;
  newsState: ReturnType<typeof useNewsArticles>;
}

/**
 * A topic code asks the service for its own feed. All and the sector codes
 * filter the one all-sector response instead of issuing a request per sector.
 */
function useIndustryArticles(entry: NewsIndustryCode | null): IndustryArticles {
  const topicQuery = entry?.topic ? NEWS_QUERY_PRESETS.topic(entry.topic) : null;
  const sectorQuery = entry && !entry.topic ? NEWS_QUERY_PRESETS.sectorAll : null;
  const topicState = useNewsArticles(topicQuery);
  const sectorState = useNewsArticles(sectorQuery);
  const topicArticles = usePersistedNewsArticles(
    `industry:topic:${entry?.topic ?? "none"}:articles`,
    topicState.articles,
    { keyFamily: "industry:topic:" },
  );
  const allArticles = usePersistedNewsArticles("industry:sector:all:articles", sectorState.articles);
  const sector = entry?.sector;
  const sectorArticles = useMemo(() => (
    sector
      ? allArticles.filter((article) => article.sectors.some((value) => value.toLowerCase() === sector))
      : allArticles
  ), [allArticles, sector]);

  const query = topicQuery ?? sectorQuery;
  const newsState = topicQuery ? topicState : sectorState;
  const shown = topicQuery ? topicArticles : sectorQuery ? sectorArticles : [];
  const persisted = topicQuery ? topicArticles : allArticles;
  return {
    articles: shown,
    loading: !!query && (newsState.phase === "loading"
      || (newsState.phase === "refreshing" && persisted.length === 0)),
    error: query ? newsState.error : null,
    query,
    newsState,
  };
}

export function IndustryPane({ focused, width, height }: PaneProps) {
  const pane = usePaneInstance();
  // Held a sector id before NI took codes; the parser reads both.
  const [savedCode, setSavedCode] = usePluginPaneState<string>("industry:category", pane?.params?.code ?? "ALL");
  const entry = parseNewsIndustryCode(savedCode);
  const code = entry?.code ?? savedCode.trim().toUpperCase();
  usePaneTitle(code === "ALL" ? TOPIC_NEWS_TITLE : `NI ${code}`);

  const { articles, loading, error, query, newsState } = useIndustryArticles(entry);
  const { scrollRef, onBodyScrollActivity } = useNewsTableLoadMore(query, newsState);
  const stack = useNewsArticleStack({
    paneKey: "industry",
    articles,
    focused,
    width,
    columns: COLUMNS,
    defaultSort: DEFAULT_SORT,
    refreshing: loading && articles.length > 0,
    error,
  });
  const { setSelectedArticleId } = stack;

  useEffect(() => {
    setSelectedArticleId(null);
  }, [code, setSelectedArticleId]);

  const options = entry
    ? CODE_OPTIONS
    : [...CODE_OPTIONS, { value: code, label: code, description: "Unknown code", disabled: true }];
  const rootBefore = (
    <QueryBar
      width={width}
      filters={[{
        id: "code",
        label: "Topic",
        title: "NI code",
        value: code,
        defaultValue: "ALL",
        options,
        onChange: setSavedCode,
      }]}
    />
  );

  return (
    <NewsArticleStackView
      {...stack}
      rootHeight={height}
      rootBefore={rootBefore}
      emptyContent={entry ? (
        <PaneStatusBody
          loading={loading}
          error={error}
          empty
          subject="Topic news"
          emptyTitle={`No ${entry.label} news yet`}
          emptyMessage="Stories appear here as the wires publish them."
        />
      ) : (
        <PaneStatusBody
          empty
          subject="Topic news"
          emptyTitle={`${code} is not an NI code`}
          emptyMessage={`Codes: ${VALID_CODES}`}
        />
      )}
      emptyStateTitle={entry ? `No ${entry.label} news yet` : `${code} is not an NI code`}
      emptyStateHint={entry ? undefined : `Codes: ${VALID_CODES}`}
      scrollRef={scrollRef}
      onBodyScrollActivity={onBodyScrollActivity}
    />
  );
}
