import { useCallback, useMemo, type ReactNode } from "react";
import { ColumnGrid, SectionHeading, type ColumnGridCell, type ColumnGridColumn } from "../../../components";
import { t, tf } from "../../../i18n";
import { useNewsArticles } from "../../../news/hooks";
import { useAppSelector } from "../../../state/app/context";
import type { MarketNewsItem } from "../../../types/news-source";
import type { TickerRecord } from "../../../types/ticker";
import { Box, useUiCapabilities } from "../../../ui";
import { clipToDisplayWidth } from "../../../utils/format";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { withPluginStateNamespace } from "../../runtime/context";
import { newsPluginMeta } from "../builtin-plugin-meta";
import { newsMutesApplyToFeed, useNewsMuteFilter } from "./wire/mutes";
import { useNewsReadState } from "./wire/read-state";
import { openNewsStoryPane } from "./wire/news/pop-out";
import {
  MIN_HEADLINE_WIDTH,
  NEWS_SOURCE_WIDTH,
  NEWS_TIME_WIDTH,
  newsHeadlineCell,
  newsSourceCell,
  newsTimeCell,
  type NewsRowCell,
} from "./wire/news/row";
import { tickerNewsQuery, tickerNewsStateKeys } from "./ticker-news";

/** Enough to see what is being said about the company; the News view has the rest. */
const OVERVIEW_STORY_COUNT = 3;
const COLUMN_GAP = 1;
/** The desktop's headline never gets narrower than this many characters; the grid clips past it. */
const HEADLINE_MIN_TRACK = 16;

interface TickerNewsHeadlinesProps {
  ticker: TickerRecord;
  /** The terminal's width for the rows, in cells, and what the desktop decides the source column from. */
  width: number;
  /**
   * Shows this pane's News view, and says whether it could: a pane locked to
   * one view, or with no News view, opens a story in a pane of its own.
   */
  openNewsView?: () => boolean;
  /** Under the headlines while there are any: the way into the ticker's full news. */
  children?: ReactNode;
}

function gridCell(cell: NewsRowCell, width: number, desktop: boolean): { text: string; color: string; attributes?: number } {
  // The terminal cuts with an ellipsis, as the news tables do; the desktop and the web cut in CSS.
  return { ...cell, text: desktop ? cell.text : clipToDisplayWidth(cell.text, width) };
}

/**
 * A ticker's latest company news, newest first, as a short section of an
 * overview: the time, the source and the headline, as the news tables show a
 * story. A headline opens its story in the pane's News view, and in a story
 * pane where there is none. Nothing is drawn until there is a story to show:
 * not while the feed loads, nor for a company with none.
 */
function TickerNewsHeadlinesView({ ticker, width, openNewsView, children }: TickerNewsHeadlinesProps) {
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const newsOff = useAppSelector((state) => state.config.disabledPlugins.includes(newsPluginMeta.id));
  const query = useMemo(() => tickerNewsQuery(ticker), [ticker]);
  const feed = useNewsArticles(newsOff ? null : query);
  const unmuted = useNewsMuteFilter(feed.articles, newsMutesApplyToFeed(query?.feed));
  const latest = useMemo(
    () => [...unmuted].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).slice(0, OVERVIEW_STORY_COUNT),
    [unmuted],
  );
  const { readArticleIds, markArticleRead } = useNewsReadState();
  const { createPaneFromTemplate } = usePluginAppActions();
  // The News view's own state for this ticker, which it opens the story from.
  const stateKeys = tickerNewsStateKeys(ticker.metadata.ticker);
  const [, setSelectedArticleId] = usePluginPaneState<string | null>(stateKeys.selectedArticleId, null);
  const [, setOpenArticleId] = usePluginPaneState<string | null>(stateKeys.openArticleId, null);
  const openStory = useCallback((article: MarketNewsItem) => {
    markArticleRead(article.id);
    if (openNewsView?.()) {
      setSelectedArticleId(article.id);
      setOpenArticleId(article.id);
      return;
    }
    openNewsStoryPane(article, createPaneFromTemplate);
  }, [createPaneFromTemplate, markArticleRead, openNewsView, setOpenArticleId, setSelectedArticleId]);

  if (latest.length === 0) return null;

  // A narrow pane gives the headline the source's room, as the news tables do.
  const showSource = width - NEWS_TIME_WIDTH - NEWS_SOURCE_WIDTH - COLUMN_GAP * 2 >= MIN_HEADLINE_WIDTH;
  const headlineWidth = Math.max(1, width - NEWS_TIME_WIDTH - COLUMN_GAP - (showSource ? NEWS_SOURCE_WIDTH + COLUMN_GAP : 0));
  const columns: ColumnGridColumn[] = [
    { width: NEWS_TIME_WIDTH },
    ...(showSource ? [{ width: NEWS_SOURCE_WIDTH, gapBefore: COLUMN_GAP }] : []),
    { width: headlineWidth, growFrom: Math.min(headlineWidth, HEADLINE_MIN_TRACK), gapBefore: COLUMN_GAP },
  ];
  const rows = latest.map((article): ColumnGridCell[] => [
    gridCell(newsTimeCell(article), NEWS_TIME_WIDTH, desktop),
    ...(showSource ? [gridCell(newsSourceCell(article), NEWS_SOURCE_WIDTH, desktop)] : []),
    {
      ...gridCell(newsHeadlineCell(article, { read: readArticleIds.has(article.id) }), headlineWidth, desktop),
      link: { label: tf("Open {label}", { label: article.title }), onOpen: () => openStory(article) },
    },
  ]);

  return (
    <Box flexDirection="column" data-gloom-role="overview-news">
      <SectionHeading title={t("News")} />
      <ColumnGrid columns={columns} rows={rows} width={width} role="news-headlines" />
      {children}
    </Box>
  );
}

/**
 * Read and written in the News plugin's own state, wherever it is drawn: the
 * stories marked read are the news tables', and a story opened here is the one
 * the pane's News view shows.
 */
export const TickerNewsHeadlines = withPluginStateNamespace(newsPluginMeta.id, TickerNewsHeadlinesView);
