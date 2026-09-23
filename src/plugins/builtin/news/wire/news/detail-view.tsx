import { Box, ScrollBox, Text, useRendererHost, useUiCapabilities } from "../../../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../../ui";
import { useShortcut } from "../../../../../react/input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketNewsItem, NewsStoryItem } from "../../../../../types/news-source";
import { colors } from "../../../../../theme/colors";
import { InlineTickerBadge } from "../../../../../components/ticker/badge";
import { ChoiceDialog, ExternalLinkText } from "../../../../../components/ui";
import { usePaneFooter } from "../../../../../components/layout/pane/footer";
import { t } from "../../../../../i18n";
import { useOptionalDialog, type PromptContext } from "../../../../../ui/dialog";
import { useOpenTickerChoice } from "../../../shared/ticker-choice";
import { collectNewsDisplayTickers } from "../../../../../news/ticker-symbols";
import { useInlineTickers } from "../../../../../state/hooks/inline-tickers";
import { isPlainKey } from "../../../../../utils/keyboard";
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

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, Math.max(0, maxWidth));
  return `${text.slice(0, maxWidth - 3)}...`;
}

const NATIVE_STRETCH_STYLE = { minWidth: 0 };
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

function NewsStoryTimelineItemView({
  item,
  width,
  nativePaneChrome,
}: {
  item: NewsStoryItem;
  width: number;
  nativePaneChrome: boolean;
}) {
  const time = formatDetailDate(storyItemDate(item.publishedAt));
  const summary = item.summary && item.summary.trim() !== item.title.trim() ? item.summary : "";
  const source = item.sourceName || item.sourceKey;
  const contentWidth = Math.max(10, width - 2);
  const sourceLabel = nativePaneChrome ? source : truncateText(source, Math.max(4, width - time.length - 4));

  return (
    <Box flexDirection="column" width={nativePaneChrome ? "100%" : width} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
      <Box height={nativePaneChrome ? undefined : 1} flexDirection="row" flexWrap={nativePaneChrome ? "wrap" : undefined} gap={nativePaneChrome ? 1 : undefined} width={nativePaneChrome ? "100%" : undefined} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
        <Text fg={colors.textDim}>{nativePaneChrome ? time : `${time}  `}</Text>
        <ExternalLinkText url={item.url} label={sourceLabel} color={colors.textBright} />
      </Box>
      <Box flexDirection="column" paddingLeft={2} width={nativePaneChrome ? "100%" : undefined} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
        <TextLines text={item.title} width={contentWidth} color={colors.text} nativePaneChrome={nativePaneChrome} />
        <TextLines text={summary} width={contentWidth} color={colors.textDim} nativePaneChrome={nativePaneChrome} />
      </Box>
    </Box>
  );
}

export function NewsDetailView({ item, focused, width, showTitle = true }: {
  item: MarketNewsItem;
  focused: boolean;
  width: number;
  showTitle?: boolean;
}) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { nativePaneChrome } = useUiCapabilities();

  const innerW = Math.max(10, Math.floor(width) - 2);
  const contentWidth = nativePaneChrome ? "100%" : innerW;
  const contentStyle = nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined;
  const tickers = useMemo(
    () => collectNewsDisplayTickers(item.tickers),
    [item.tickers],
  );
  const tickerTexts = useMemo(() => tickers.map((ticker) => `$${ticker}`), [tickers]);
  const { catalog, openTicker } = useInlineTickers(tickerTexts, { badgeQuotes: true });
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null);
  const timelineItems = useMemo(() => sortStoryItems(item.items), [item.items]);
  const categoryLabels = useMemo(
    () => item.categories.map(formatNewsCategory).filter(Boolean).join(" · "),
    [item.categories],
  );
  const lastUpdatedAt = new Date(Math.max(
    storyItemDate(item.publishedAt).getTime(),
    storyItemDate(timelineItems[0]?.publishedAt ?? item.publishedAt).getTime(),
  ));
  const lastUpdatedStr = formatDetailDate(lastUpdatedAt);

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

  const scrollBy = useCallback((delta: number) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox?.viewport) return;
    const maxScrollTop = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height);
    scrollBox.scrollTop = Math.max(0, Math.min(maxScrollTop, scrollBox.scrollTop + delta));
  }, []);

  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) scrollBox.scrollTop = 0;
  }, [item.id]);

  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "j", "down")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollBy(1);
      return;
    }
    if (isPlainKey(event, "k", "up")) {
      event.stopPropagation?.();
      event.preventDefault?.();
      scrollBy(-1);
    }
  });

  return (
    <Box flexDirection="column" width={nativePaneChrome ? "100%" : width} flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      <ScrollBox ref={scrollRef} flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1} width={nativePaneChrome ? "100%" : undefined} style={contentStyle}>
          {showTitle && (
            <Box flexDirection="column">
              <TextLines
                text={item.title}
                width={innerW}
                color={colors.textBright}
                attributes={TextAttributes.BOLD}
                nativePaneChrome={nativePaneChrome === true}
              />
            </Box>
          )}
          {/* The source is the footer's [o]pen link; without a link the footer has no source, so it stays here. */}
          <Box height={nativePaneChrome ? undefined : 1} flexDirection="row">
            <Text fg={colors.textDim} wrapText={nativePaneChrome}>
              {`${item.url?.trim() || !item.source ? "" : `${item.source} · `}Last updated ${lastUpdatedStr} · score ${item.importance}/100`}
            </Text>
          </Box>
          <TextLines text={item.summary} width={innerW} color={colors.text} nativePaneChrome={nativePaneChrome === true} />
          {tickers.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" width={contentWidth} style={contentStyle}>
              {tickers.map((ticker) => {
                const entry = catalog[ticker];
                if (!entry || entry.status === "missing") {
                  return (
                    <Box key={ticker} paddingRight={1}>
                      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
                        {ticker}
                      </Text>
                    </Box>
                  );
                }

                return (
                  <InlineTickerBadge
                    key={ticker}
                    symbol={ticker}
                    entry={entry}
                    hovered={hoveredTicker === ticker}
                    onHoverStart={() => setHoveredTicker(ticker)}
                    onHoverEnd={() => {
                      setHoveredTicker((current) => (current === ticker ? null : current));
                    }}
                    onOpen={openTicker}
                  />
                );
              })}
            </Box>
          )}
          {item.categories.length > 0 && (
            nativePaneChrome ? (
              <TextLines text={categoryLabels} width={innerW} color={colors.textMuted} nativePaneChrome />
            ) : (
              <Box height={1} flexDirection="row">
                <Text fg={colors.textMuted}>{categoryLabels}</Text>
              </Box>
            )
          )}
          {timelineItems.length > 0 && (
            <Box flexDirection="column" gap={1} width={contentWidth} style={contentStyle}>
              {timelineItems.map((timelineItem) => (
                <NewsStoryTimelineItemView
                  key={timelineItem.id}
                  item={timelineItem}
                  width={innerW}
                  nativePaneChrome={nativePaneChrome === true}
                />
              ))}
            </Box>
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}
