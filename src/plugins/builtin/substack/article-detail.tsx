import { memo, useCallback, useMemo, type RefObject } from "react";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import { Spinner } from "../../../components";
import { RemoteImage } from "../../../components/ui";
import { TickerBadgeText } from "../../../components/ticker/badge/text";
import { useInlineTickers } from "../../../state/hooks/inline-tickers";
import { colors } from "../../../theme/colors";
import { formatReadTime, formatWordCount } from "./table";
import type {
  SubstackArticleDetail,
  SubstackArticleSummary,
  SubstackContentBlock,
} from "./types";

function articleBlockText(block: SubstackContentBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "quote":
    case "listItem":
      return block.text;
    case "embed":
      return [block.text, block.url].filter(Boolean).join("\n");
    default:
      return "";
  }
}

function wrappedTextProps(width: number) {
  return {
    width,
    wrapText: true,
    wrapMode: "word",
    style: {
      minWidth: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  } as const;
}

const ARTICLE_IMAGE_MAX_WIDTH = 152;
const ARTICLE_IMAGE_MAX_HEIGHT = 26;
const ARTICLE_IMAGE_MIN_HEIGHT = 6;
const ARTICLE_IMAGE_LEGACY_HEIGHT_CAP = 14;

function resolveArticleImageSize(lineWidth: number) {
  const safeLineWidth = Math.max(1, Math.floor(lineWidth));
  const width = Math.min(safeLineWidth, ARTICLE_IMAGE_MAX_WIDTH);
  const legacyHeight = Math.min(ARTICLE_IMAGE_LEGACY_HEIGHT_CAP, Math.floor(width * 0.32));
  const expandedHeight = Math.floor(width * 0.18);
  return {
    width,
    height: Math.max(ARTICLE_IMAGE_MIN_HEIGHT, Math.min(
      ARTICLE_IMAGE_MAX_HEIGHT,
      Math.max(legacyHeight, expandedHeight),
    )),
  };
}

function normalizedTwitterUsername(username: string | null | undefined): string | null {
  const normalized = username?.trim().replace(/^@/, "") ?? "";
  return /^[A-Za-z0-9_]{1,15}$/.test(normalized) ? normalized : null;
}

function TweetEmbedView({
  block,
  lineWidth,
  imageWidth,
  imageHeight,
  catalog,
  openTicker,
  openLink,
  openUsername,
}: {
  block: Extract<SubstackContentBlock, { type: "embed"; kind: "tweet" }>;
  lineWidth: number;
  imageWidth: number;
  imageHeight: number;
  catalog: ReturnType<typeof useInlineTickers>["catalog"];
  openTicker: ReturnType<typeof useInlineTickers>["openTicker"];
  openLink: (url: string) => void;
  openUsername: (username: string) => void;
}) {
  const username = normalizedTwitterUsername(block.username);
  const contentWidth = Math.max(1, lineWidth - 3);

  return (
    <Box flexDirection="column" width={lineWidth} paddingX={1}>
      <Box flexDirection="row" width={Math.max(1, lineWidth - 2)}>
        <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>Tweet</Text>
        {username ? (
          <Text
            fg={colors.borderFocused}
            onMouseDown={() => openUsername(username)}
          >
            {` @${username}`}
          </Text>
        ) : null}
        {block.dateLabel ? <Text fg={colors.textDim}>{` | ${block.dateLabel}`}</Text> : null}
      </Box>
      <Box flexDirection="row" width={Math.max(1, lineWidth - 2)}>
        <Text fg={colors.borderFocused}>| </Text>
        <Box width={contentWidth}>
          <TickerBadgeText
            text={block.text}
            lineWidth={contentWidth}
            catalog={catalog}
            textColor={colors.text}
            openTicker={openTicker}
            openLink={openLink}
            openUsername={openUsername}
          />
        </Box>
      </Box>
      {block.imageUrls.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {block.imageUrls.slice(0, 2).map((url, index) => (
            <RemoteImage
              key={url}
              src={url}
              alt={`Tweet image ${index + 1}`}
              width={Math.max(1, imageWidth - 2)}
              height={Math.max(4, Math.min(imageHeight, 10))}
              label={block.imageUrls.length > 1 ? `tweet image ${index + 1}` : "tweet image"}
            />
          ))}
        </Box>
      ) : null}
      {block.url ? (
        <Text
          fg={colors.borderFocused}
          onMouseDown={() => openLink(block.url!)}
        >
          open tweet
        </Text>
      ) : null}
    </Box>
  );
}

function ArticleBlockView({
  block,
  lineWidth,
  imageWidth,
  imageHeight,
  catalog,
  openTicker,
  openLink,
  openUsername,
}: {
  block: SubstackContentBlock;
  lineWidth: number;
  imageWidth: number;
  imageHeight: number;
  catalog: ReturnType<typeof useInlineTickers>["catalog"];
  openTicker: ReturnType<typeof useInlineTickers>["openTicker"];
  openLink: (url: string) => void;
  openUsername: (username: string) => void;
}) {
  switch (block.type) {
    case "heading":
      return (
        <Text
          fg={colors.textBright}
          attributes={TextAttributes.BOLD}
          {...wrappedTextProps(lineWidth)}
        >
          {block.text}
        </Text>
      );
    case "quote":
      return (
        <Box flexDirection="row" width={lineWidth}>
          <Text fg={colors.warning}>| </Text>
          <Box width={Math.max(1, lineWidth - 2)}>
            <TickerBadgeText
              text={block.text}
              lineWidth={Math.max(1, lineWidth - 2)}
              catalog={catalog}
              textColor={colors.textDim}
              openTicker={openTicker}
              openLink={openLink}
              openUsername={openUsername}
            />
          </Box>
        </Box>
      );
    case "listItem":
      return (
        <Box flexDirection="row" width={lineWidth}>
          <Text fg={colors.textDim}>- </Text>
          <Box width={Math.max(1, lineWidth - 2)}>
            <TickerBadgeText
              text={block.text}
              lineWidth={Math.max(1, lineWidth - 2)}
              catalog={catalog}
              textColor={colors.text}
              openTicker={openTicker}
              openLink={openLink}
              openUsername={openUsername}
            />
          </Box>
        </Box>
      );
    case "image":
      return (
        <RemoteImage
          src={block.url}
          alt={block.alt ?? "Substack image"}
          width={imageWidth}
          height={imageHeight}
          label={block.alt ?? "image"}
        />
      );
    case "embed":
      if (block.kind === "tweet") {
        return (
          <TweetEmbedView
            block={block}
            lineWidth={lineWidth}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            catalog={catalog}
            openTicker={openTicker}
            openLink={openLink}
            openUsername={openUsername}
          />
        );
      }
      return (
        <Box flexDirection="column" width={lineWidth} paddingX={1}>
          <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
            {block.kind === "media" ? "Media" : "Link"}
          </Text>
          <TickerBadgeText
            text={block.text}
            lineWidth={Math.max(1, lineWidth - 2)}
            catalog={catalog}
            textColor={colors.text}
            openTicker={openTicker}
            openLink={openLink}
            openUsername={openUsername}
          />
          {block.url ? (
            <Text
              fg={colors.borderFocused}
              onMouseDown={() => openLink(block.url!)}
              {...wrappedTextProps(Math.max(1, lineWidth - 2))}
            >
              {block.url}
            </Text>
          ) : null}
        </Box>
      );
    case "divider":
      // A real filled rule in both renderers instead of a row of hyphens.
      return (
        <Box height={1} width={Math.max(1, Math.min(lineWidth, 96))} backgroundColor={colors.border} />
      );
    case "paragraph":
    default:
      return (
        <TickerBadgeText
          text={block.text}
          lineWidth={lineWidth}
          catalog={catalog}
          textColor={colors.text}
          openTicker={openTicker}
          openLink={openLink}
          openUsername={openUsername}
        />
      );
  }
}

const ArticleRichContent = memo(function ArticleRichContent({
  blocks,
  fallbackText,
  fallbackImageUrls,
  articleTitle,
  lineWidth,
  imageWidth,
  imageHeight,
}: {
  blocks: SubstackContentBlock[];
  fallbackText: string;
  fallbackImageUrls: string[];
  articleTitle: string;
  lineWidth: number;
  imageWidth: number;
  imageHeight: number;
}) {
  const rendererHost = useRendererHost();
  const resolvedBlocks = useMemo(() => (
    blocks.length > 0
      ? blocks
      : [
        ...(fallbackText ? [{ type: "paragraph" as const, text: fallbackText }] : []),
        ...fallbackImageUrls.map((url): SubstackContentBlock => ({ type: "image", url, alt: articleTitle })),
      ]
  ), [articleTitle, blocks, fallbackImageUrls, fallbackText]);
  const tickerText = useMemo(
    () => resolvedBlocks.map(articleBlockText).filter(Boolean).join("\n"),
    [resolvedBlocks],
  );
  const tickerTexts = useMemo(() => [tickerText], [tickerText]);
  const { catalog, openTicker } = useInlineTickers(tickerTexts, { liveQuotes: false });
  const openLink = useCallback((url: string) => {
    void rendererHost.openExternal(url);
  }, [rendererHost]);
  const openUsername = useCallback((username: string) => {
    const normalized = normalizedTwitterUsername(username);
    if (!normalized) return;
    void rendererHost.openExternal(`https://x.com/${normalized}`);
  }, [rendererHost]);

  if (resolvedBlocks.length === 0) {
    return <Text fg={colors.textDim}>No article text returned.</Text>;
  }

  return (
    <Box flexDirection="column" width={lineWidth} gap={1}>
      {resolvedBlocks.map((block, index) => (
        <ArticleBlockView
          key={`${block.type}:${index}:${articleBlockText(block).slice(0, 32)}`}
          block={block}
          lineWidth={lineWidth}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
          catalog={catalog}
          openTicker={openTicker}
          openLink={openLink}
          openUsername={openUsername}
        />
      ))}
    </Box>
  );
});

export const ArticleDetail = memo(function ArticleDetail({
  article,
  detail,
  width,
  loading,
  error,
  scrollRef,
  onOpenArticle,
}: {
  article: SubstackArticleSummary;
  detail: SubstackArticleDetail | null;
  width: number;
  loading: boolean;
  error: string | null;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onOpenArticle: () => void;
}) {
  const resolved = detail ?? null;
  const text = resolved?.contentText || article.previewText || article.subtitle || "";
  const blocks = resolved?.contentBlocks ?? [];
  const fallbackImageUrls = resolved?.imageUrls.length ? resolved.imageUrls : article.imageUrls;
  const lineWidth = Math.max(1, width - 2);
  const { width: imageWidth, height: imageHeight } = resolveArticleImageSize(lineWidth);

  return (
    <ScrollBox ref={scrollRef} scrollY focusable={false} flexGrow={1} paddingX={1}>
      <Box flexDirection="column" width={lineWidth} gap={1}>
        {/* The stack title already names the article, so the body opens on its metadata. */}
        <Box height={1}>
          <Text fg={colors.textDim}>
            {[
              article.publicationName,
              formatReadTime(resolved?.readMinutes ?? article.readMinutes),
              formatWordCount(resolved?.wordCount ?? article.wordCount),
            ].filter(Boolean).join("  ·  ")}
          </Text>
        </Box>
        {loading && !resolved ? <Spinner label="Loading article..." /> : null}
        {error ? <Text fg={colors.negative}>{error}</Text> : null}
        <ArticleRichContent
          blocks={blocks}
          fallbackText={text}
          fallbackImageUrls={fallbackImageUrls}
          articleTitle={article.title}
          lineWidth={lineWidth}
          imageWidth={imageWidth}
          imageHeight={imageHeight}
        />
        {article.url ? (
          <Box height={1}>
            <Text fg={colors.textDim} onMouseDown={onOpenArticle}>Open source: O</Text>
          </Box>
        ) : null}
      </Box>
    </ScrollBox>
  );
});
