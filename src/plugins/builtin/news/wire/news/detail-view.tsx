import { Box, Text, useRendererHost, useUiCapabilities } from "../../../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketNewsItem, NewsStoryItem } from "../../../../../types/news-source";
import { colors } from "../../../../../theme/colors";
import { ArticleReader } from "../../../../../components/reader/article-reader";
import type { ArticleBlock } from "../../../../../components/reader/article-text";
import { ChoiceDialog, ExternalLinkText } from "../../../../../components/ui";
import { usePaneFooter } from "../../../../../components/layout/pane/footer";
import { t } from "../../../../../i18n";
import { useOptionalDialog, type PromptContext } from "../../../../../ui/dialog";
import { useOpenTickerChoice } from "../../../shared/ticker-choice";
import { collectNewsDisplayTickers } from "../../../../../news/ticker-symbols";
import { useInlineTickers } from "../../../../../state/hooks/inline-tickers";
import { truncateToDisplayWidth } from "../../../../../utils/format";
import { wrapTextLines } from "../../../../../utils/text-wrap";
import { formatDetailDate } from "../../../../../utils/datetime-format";
import { mergeNewsArticle } from "../../../../../news/news-model";
import { usePluginPaneState } from "../../../../runtime";
import { formatNewsCategory } from "../categories";

function hasStoryItems(article: MarketNewsItem | null): boolean {
  return (article?.items?.length ?? 0) > 0;
}

/**
 * The open story is pane state, not component state: it is part of what the
 * pane shows, so it survives a relaunch and travels with a shared pane. A
 * receiver's feed may no longer list the story, so an id the feed cannot
 * explain is fetched by id before it is given up on.
 */
export function useNewsArticleDetail(
  articles: MarketNewsItem[],
  loadArticleDetail?: (articleId: string) => Promise<MarketNewsItem | null>,
  stateKey = "openArticleId",
) {
  const [detailArticleId, setDetailArticleId] = usePluginPaneState<string | null>(stateKey, null);
  const [request, setRequest] = useState<{
    base: MarketNewsItem;
    article?: MarketNewsItem;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [standalone, setStandalone] = useState<{
    id: string;
    article: MarketNewsItem | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const requestedArticle = useRef<MarketNewsItem | null>(null);
  const standaloneRequestId = useRef<string | null>(null);
  const listedDetailArticle = useMemo(
    () => articles.find((article) => article.id === detailArticleId) ?? null,
    [articles, detailArticleId],
  );
  const currentStandalone = standalone?.id === detailArticleId ? standalone : null;
  const baseDetailArticle = listedDetailArticle ?? currentStandalone?.article ?? null;
  // The service owns cached stories. A local completion only belongs to the
  // exact feed revision that requested it; it must never cover a newer update.
  const currentRequest = request?.base === baseDetailArticle ? request : null;
  const detailArticle = currentRequest?.article ?? baseDetailArticle;

  useEffect(() => {
    if (!detailArticleId || listedDetailArticle) {
      standaloneRequestId.current = null;
      return;
    }
    if (currentStandalone) {
      if (!currentStandalone.loading && !currentStandalone.article) setDetailArticleId(null);
      return;
    }
    if (!loadArticleDetail) {
      setDetailArticleId(null);
      return;
    }
    const id = detailArticleId;
    // The pending marker re-runs this effect; the request it belongs to must
    // not be cancelled by that re-run, only by a change of story.
    if (standaloneRequestId.current === id) return;
    standaloneRequestId.current = id;
    setStandalone({ id, article: null, loading: true, error: null });
    void loadArticleDetail(id)
      .then((article) => {
        if (standaloneRequestId.current !== id) return;
        setStandalone({ id, article: article?.id === id ? article : null, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (standaloneRequestId.current !== id) return;
        setStandalone({ id, article: null, loading: false, error: error instanceof Error ? error.message : "Story detail unavailable." });
      });
  }, [currentStandalone, detailArticleId, listedDetailArticle, loadArticleDetail, setDetailArticleId]);

  useEffect(() => {
    if (!baseDetailArticle || hasStoryItems(baseDetailArticle) || !loadArticleDetail) return;
    // A story fetched by id is already the detail; asking again adds nothing.
    if (baseDetailArticle === currentStandalone?.article) return;
    if (requestedArticle.current === baseDetailArticle) return;
    requestedArticle.current = baseDetailArticle;
    let active = true;
    setRequest({ base: baseDetailArticle, loading: true, error: null });
    void loadArticleDetail(baseDetailArticle.id)
      .then((article) => {
        if (!active) return;
        if (article && article.id !== baseDetailArticle.id) throw new Error("Story detail identity mismatch.");
        setRequest({ base: baseDetailArticle, article: article ? mergeNewsArticle(baseDetailArticle, article) : undefined, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRequest({ base: baseDetailArticle, loading: false, error: error instanceof Error ? error.message : "Story detail unavailable." });
      });
    return () => { active = false; };
  }, [baseDetailArticle, currentStandalone?.article, loadArticleDetail]);

  const openArticle = useCallback((article: MarketNewsItem) => {
    requestedArticle.current = null;
    standaloneRequestId.current = null;
    setDetailArticleId(article.id);
  }, [setDetailArticleId]);
  const closeDetail = useCallback(() => {
    requestedArticle.current = null;
    standaloneRequestId.current = null;
    setDetailArticleId(null);
    setRequest(null);
    setStandalone(null);
  }, [setDetailArticleId]);

  return {
    detailArticle,
    detailLoading: (currentRequest?.loading ?? false) || (currentStandalone?.loading ?? false),
    detailError: currentRequest?.error ?? currentStandalone?.error ?? null,
    openArticle,
    closeDetail,
  };
}

function wrapText(text: string, width: number): string[] {
  return text ? wrapTextLines(text, width) : [];
}

function storyItemDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function sortStoryItems(items: readonly NewsStoryItem[] | undefined): NewsStoryItem[] {
  return [...(items ?? [])].sort((a, b) => (
    storyItemDate(b.publishedAt).getTime() - storyItemDate(a.publishedAt).getTime()
  ));
}

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
/** A story is its summary and its coverage: the reader has no article text for it. */
const NO_BODY: ArticleBlock[] = [];
const NATIVE_TEXT_STYLE = { display: "block" };

function TextLines({
  text,
  width,
  color,
  attributes,
  nativePaneChrome,
}: {
  text: string | undefined;
  width: number;
  color: string;
  attributes?: number;
  nativePaneChrome: boolean;
}) {
  if (!text) return null;
  if (nativePaneChrome) {
    return (
      <Text fg={color} attributes={attributes} wrapText width="100%" style={NATIVE_TEXT_STYLE}>
        {text}
      </Text>
    );
  }

  return wrapText(text, width).map((line, index) => (
    <Box key={index} height={1}>
      <Text fg={color} attributes={attributes}>{line}</Text>
    </Box>
  ));
}

/** The time alone on the story's own day, which the header already dates; the date otherwise. */
function coverageTime(value: Date, storyDay: Date): string {
  return value.toDateString() === storyDay.toDateString()
    ? value.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : formatDetailDate(value);
}

function NewsStoryTimelineItemView({
  item,
  storyTitle,
  storyDay,
  width,
  nativePaneChrome,
}: {
  item: NewsStoryItem;
  /** An outlet's headline that is the story's own is not printed again. */
  storyTitle: string;
  storyDay: Date;
  width: number;
  nativePaneChrome: boolean;
}) {
  const time = coverageTime(storyItemDate(item.publishedAt), storyDay);
  const title = item.title.trim() === storyTitle.trim() ? "" : item.title;
  const summary = item.summary && item.summary.trim() !== item.title.trim() ? item.summary : "";
  const source = item.sourceName || item.sourceKey;
  const contentWidth = Math.max(10, width - 2);
  const sourceLabel = nativePaneChrome ? source : truncateToDisplayWidth(source, Math.max(4, width - time.length - 4));

  return (
    <Box flexDirection="column" width={nativePaneChrome ? "100%" : width} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
      <Box height={nativePaneChrome ? undefined : 1} flexDirection="row" flexWrap={nativePaneChrome ? "wrap" : undefined} gap={nativePaneChrome ? 1 : undefined} width={nativePaneChrome ? "100%" : undefined} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
        <Text fg={colors.textDim}>{nativePaneChrome ? time : `${time}  `}</Text>
        <ExternalLinkText url={item.url} label={sourceLabel} color={colors.textBright} />
      </Box>
      <Box flexDirection="column" paddingLeft={2} width={nativePaneChrome ? "100%" : undefined} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
        <TextLines text={title} width={contentWidth} color={colors.text} nativePaneChrome={nativePaneChrome} />
        <TextLines text={summary} width={contentWidth} color={colors.textDim} nativePaneChrome={nativePaneChrome} />
      </Box>
    </Box>
  );
}

export function NewsDetailView({ item, focused, width, showTitle = true }: {
  item: MarketNewsItem;
  focused: boolean;
  width: number;
  /** Off where the pane's own title is the headline, as in a story popped out to its own pane. */
  showTitle?: boolean;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const tickers = useMemo(
    () => collectNewsDisplayTickers(item.tickers),
    [item.tickers],
  );
  const tickerTexts = useMemo(() => tickers.map((ticker) => `$${ticker}`), [tickers]);
  const { catalog } = useInlineTickers(tickerTexts, { badgeQuotes: true });
  const timelineItems = useMemo(() => sortStoryItems(item.items), [item.items]);
  const categoryLabels = useMemo(
    () => item.categories.map(formatNewsCategory).filter(Boolean).join(" \u00b7 "),
    [item.categories],
  );
  const lastUpdatedAt = new Date(Math.max(
    storyItemDate(item.publishedAt).getTime(),
    storyItemDate(timelineItems[0]?.publishedAt ?? item.publishedAt).getTime(),
  ));

  // The badges and outlet links, for the keyboard: [t]icker opens a mentioned
  // company, [s]ources picks another outlet's coverage to read.
  const openTickerChoice = useOpenTickerChoice();
  // The same symbols a click can open: plain text never named an instrument.
  // Keyed by text, since the catalog is rebuilt on every quote.
  const openableKey = tickers.filter((ticker) => catalog[ticker] && catalog[ticker].status !== "missing").join(" ");
  const openableTickers = useMemo(() => (openableKey ? openableKey.split(" ") : []), [openableKey]);
  const dialog = useOptionalDialog();
  const rendererHost = useRendererHost();
  const coverage = useMemo(() => timelineItems.filter((entry) => !!entry.url), [timelineItems]);
  const hasOtherCoverage = coverage.some((entry) => entry.url !== item.url);
  const chooseSource = useCallback(() => {
    if (!dialog || coverage.length === 0) return;
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (ctx: PromptContext<string>) => (
        <ChoiceDialog
          {...ctx}
          title={t("Coverage")}
          choices={coverage.map((entry, index) => ({
            id: String(index),
            label: entry.sourceName || entry.sourceKey,
            detail: formatDetailDate(storyItemDate(entry.publishedAt)),
            description: entry.title,
          }))}
        />
      ),
    }).then((choice) => {
      const url = choice ? coverage[Number(choice)]?.url : undefined;
      if (url) void rendererHost.openExternal(url);
    }).catch(() => {});
  }, [coverage, dialog, rendererHost]);
  usePaneFooter("news-detail:story", () => ({
    order: -1,
    hints: [
      ...(openableTickers.length > 0
        ? [{ id: "ticker", key: "t", label: "icker", onPress: () => openTickerChoice(openableTickers) }]
        : []),
      ...(hasOtherCoverage && dialog
        ? [{ id: "sources", key: "s", label: "ources", onPress: chooseSource }]
        : []),
    ],
  }), [chooseSource, dialog, hasOtherCoverage, openTickerChoice, openableTickers]);

  // One outlet's own headline is the story's: the timeline is worth its rows
  // once a second outlet has written about it.
  const showTimeline = timelineItems.length > 1 || (timelineItems.length === 1 && timelineItems[0]!.title.trim() !== item.title.trim());
  const coverageWidth = Math.max(20, Math.min(72, Math.floor(width) - 6));

  return (
    <ArticleReader
      articleKey={item.id}
      title={showTitle ? item.title : null}
      meta={[item.source, formatDetailDate(lastUpdatedAt), categoryLabels]}
      tickers={tickers}
      lead={item.summary}
      body={NO_BODY}
      focused={focused}
      width={width}
      height={0}
      childrenLabel={showTimeline ? "Coverage" : undefined}
    >
      {showTimeline && (
        <Box flexDirection="column" gap={1} width={nativePaneChrome ? "100%" : coverageWidth} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
          {timelineItems.map((timelineItem) => (
            <NewsStoryTimelineItemView
              key={timelineItem.id}
              item={timelineItem}
              storyTitle={item.title}
              storyDay={lastUpdatedAt}
              width={coverageWidth}
              nativePaneChrome={nativePaneChrome === true}
            />
          ))}
        </Box>
      )}
    </ArticleReader>
  );
}
