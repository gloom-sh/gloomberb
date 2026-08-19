import { Box, ScrollBox, Text, useUiCapabilities } from "../../../../../ui";
import { TextAttributes, type ScrollBoxRenderable } from "../../../../../ui";
import { useShortcut } from "../../../../../react/input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketNewsItem, NewsStoryItem } from "../../../../../types/news-source";
import { colors } from "../../../../../theme/colors";
import { TickerBadge } from "../../../../../components/ticker/badge";
import { ExternalLink, ExternalLinkText } from "../../../../../components/ui";
import { collectNewsDisplayTickers } from "../../../../../news/ticker-symbols";
import { useInlineTickers } from "../../../../../state/hooks/inline-tickers";
import { isPlainKey } from "../../../../../utils/keyboard";
import { wrapTextLines } from "../../../../../utils/text-wrap";
import { formatDetailDate } from "../../../../../utils/datetime-format";
import { formatNewsCategory } from "../categories";

function hasStoryItems(article: MarketNewsItem | null): boolean {
  return (article?.items?.length ?? 0) > 0;
}

function mergeLoadedArticle(base: MarketNewsItem, loaded: MarketNewsItem | null | undefined): MarketNewsItem {
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    items: hasStoryItems(loaded) ? loaded.items : base.items,
  };
}

export function useNewsArticleDetail(
  articles: MarketNewsItem[],
  loadArticleDetail?: (articleId: string) => Promise<MarketNewsItem | null>,
) {
  const [detailArticleId, setDetailArticleId] = useState<string | null>(null);
  const [loadedArticles, setLoadedArticles] = useState<Map<string, MarketNewsItem>>(() => new Map());
  const requestedArticleIds = useRef<Set<string>>(new Set());
  const baseDetailArticle = useMemo(
    () => (
      detailArticleId
        ? articles.find((article) => article.id === detailArticleId) ?? null
        : null
    ),
    [articles, detailArticleId],
  );
  const detailArticle = useMemo(() => (
    baseDetailArticle && detailArticleId
      ? mergeLoadedArticle(baseDetailArticle, loadedArticles.get(detailArticleId))
      : baseDetailArticle
  ), [baseDetailArticle, detailArticleId, loadedArticles]);

  useEffect(() => {
    if (detailArticleId && !baseDetailArticle) {
      setDetailArticleId(null);
    }
  }, [baseDetailArticle, detailArticleId]);

  useEffect(() => {
    if (!detailArticleId || !baseDetailArticle || hasStoryItems(detailArticle)) return;
    if (!loadArticleDetail || requestedArticleIds.current.has(detailArticleId)) return;

    requestedArticleIds.current.add(detailArticleId);
    void loadArticleDetail(detailArticleId)
      .then((loadedArticle) => {
        if (!loadedArticle) return;
        setLoadedArticles((current) => {
          const next = new Map(current);
          next.set(detailArticleId, loadedArticle);
          return next;
        });
      })
      .catch(() => {
        requestedArticleIds.current.delete(detailArticleId);
      });
  }, [baseDetailArticle, detailArticle, detailArticleId, loadArticleDetail]);

  const openArticle = useCallback((article: MarketNewsItem) => {
    setDetailArticleId(article.id);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailArticleId(null);
  }, []);

  return {
    detailArticle,
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
  index,
  total,
  width,
  nativePaneChrome,
}: {
  item: NewsStoryItem;
  index: number;
  total: number;
  width: number;
  nativePaneChrome: boolean;
}) {
  const marker = total <= 1 ? "*" : index === 0 || index === total - 1 ? "+" : "|";
  const time = formatDetailDate(storyItemDate(item.publishedAt));
  const summary = item.summary && item.summary.trim() !== item.title.trim() ? item.summary : "";
  const source = item.sourceName || item.sourceKey;
  const contentWidth = Math.max(10, width - 2);
  const sourceLabel = nativePaneChrome ? source : truncateText(source, Math.max(4, width - time.length - 4));

  return (
    <Box flexDirection="column" width={nativePaneChrome ? "100%" : width} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
      <Box height={nativePaneChrome ? undefined : 1} flexDirection="row" flexWrap={nativePaneChrome ? "wrap" : undefined} gap={nativePaneChrome ? 1 : undefined} width={nativePaneChrome ? "100%" : undefined} style={nativePaneChrome ? NATIVE_STRETCH_STYLE : undefined}>
        <Text fg={colors.textDim}>{nativePaneChrome ? `${marker} ${time}` : `${marker} ${time}  `}</Text>
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
  const { catalog, openTicker } = useInlineTickers(tickerTexts);
  const [hoveredTicker, setHoveredTicker] = useState<string | null>(null);
  const timelineItems = useMemo(() => sortStoryItems(item.items), [item.items]);
  const categoryLabels = useMemo(
    () => item.categories.map(formatNewsCategory).filter(Boolean).join(" · "),
    [item.categories],
  );
  const lastUpdatedAt = timelineItems[0]?.publishedAt ?? item.publishedAt;
  const lastUpdatedStr = formatDetailDate(storyItemDate(lastUpdatedAt));

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
          <Box height={1} flexDirection="row">
            <Text fg={colors.textDim}>
              {`${item.source} · last updated at ${lastUpdatedStr} · score ${item.importance}/100`}
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
                  <TickerBadge
                    key={ticker}
                    symbol={ticker}
                    status={entry.status}
                    quote={entry.quote}
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
              {timelineItems.map((timelineItem, index) => (
                <NewsStoryTimelineItemView
                  key={timelineItem.id}
                  item={timelineItem}
                  index={index}
                  total={timelineItems.length}
                  width={innerW}
                  nativePaneChrome={nativePaneChrome === true}
                />
              ))}
            </Box>
          )}
          <ExternalLink url={item.url} color={colors.textDim} />
        </Box>
      </ScrollBox>
    </Box>
  );
}
