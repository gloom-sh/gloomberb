import type { ScrollBoxRenderable } from "../../../ui";
import type { ChatMessage } from "../../../api-client";
import { splitLongTextSegmentByDisplayWidth, truncateWithEllipsis } from "../../../utils/text-wrap";
import { tokenizeInlineContent, type InlineContentToken } from "../../../utils/inline-content-tokenizer";
import { displayWidth } from "../../../utils/format";
import {
  getTickerBadgeText,
  TICKER_BADGE_CHROME_WIDTH,
  type TickerBadgeStatus,
} from "../../../components/ticker/badge/format";
import type { InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";

const MESSAGE_GROUP_THRESHOLD_MS = 5 * 60 * 1000;
const MESSAGE_SELECTION_BOTTOM_INSET = 1;
const SCROLL_BOTTOM_THRESHOLD_PX = 2;

export const CHAT_COMPOSER_MAX_ROWS = 5;
export const MESSAGE_ACTION_WIDTH = 9;
export const COMPOSER_ACTION_WIDTH = 10;

export function isGroupedWithPrevious(messages: ChatMessage[], index: number) {
  if (index === 0) return false;
  const prev = messages[index - 1]!;
  const curr = messages[index]!;
  if (prev.user.id !== curr.user.id) return false;
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() < MESSAGE_GROUP_THRESHOLD_MS;
}

export function normalizeInlinePreview(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function formatInlinePreview(text: string, width: number) {
  return truncateWithEllipsis(normalizeInlinePreview(text), width);
}

export type ChatBodyInlineToken = InlineContentToken;

export type ChatBodyLine = ChatBodyInlineToken[];

function wrapTextLines(text: string, width: number) {
  const safeWidth = Math.max(width, 1);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let remaining = paragraph;
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }

    while (remaining.length > safeWidth) {
      const candidate = remaining.slice(0, safeWidth + 1);
      const breakAt = candidate.lastIndexOf(" ");
      const lineEnd = breakAt > 0 ? breakAt : safeWidth;
      lines.push(remaining.slice(0, lineEnd).trimEnd());
      remaining = remaining.slice(lineEnd).trimStart();
    }

    lines.push(remaining);
  }

  return lines.length > 0 ? lines : [""];
}

/** The widest day change a chat chip is laid out for. */
const RESERVED_BADGE_CHANGE_PERCENT = -999.9;

/**
 * Text width of a chat chip. Chips follow their own quote while the transcript
 * is wrapped from the first one, so the width covers the widest day change and
 * a hovered price with one more integer digit. Terminal lines render the chip
 * with this as its `maxTextWidth`, so a move past either drops detail instead
 * of spilling into the next token.
 */
export function chatBadgeTextWidth(symbol: string, entry: InlineTickerCatalogEntry): number {
  const status: TickerBadgeStatus = entry.status === "loading" || entry.status === "ambiguous" ? entry.status : "ready";
  const quote = entry.quote;
  const widths = [displayWidth(getTickerBadgeText({ symbol, status, quote }))];
  if (quote) {
    if (status === "ready") {
      widths.push(displayWidth(getTickerBadgeText({
        symbol,
        status,
        quote: { ...quote, changePercent: RESERVED_BADGE_CHANGE_PERCENT },
      })));
    }
    for (const price of [quote.price, quote.price * 10]) {
      widths.push(displayWidth(getTickerBadgeText({ symbol, status, quote: { ...quote, price }, hovered: true })));
    }
  }
  return Math.max(...widths);
}

function inlineTokenWidth(
  token: InlineContentToken,
  catalog: Record<string, InlineTickerCatalogEntry>,
): number {
  if (token.kind !== "ticker") return displayWidth(token.value);

  const entry = catalog[token.symbol];
  if (!entry || entry.status === "missing") return displayWidth(token.value);

  // A live chip's change and price move with every tick; reserving their
  // widest forms keeps the wrapped lines (and the scroll offsets) stable.
  return chatBadgeTextWidth(token.symbol, entry) + TICKER_BADGE_CHROME_WIDTH;
}

function tokenWithValue(token: InlineContentToken, value: string): InlineContentToken {
  if (token.kind === "link") return { ...token, value };
  if (token.kind === "username") return { ...token, value };
  if (token.kind === "ticker") return { ...token, value };
  return { kind: "text", value };
}

function firstDisplayWidthChunk(value: string, width: number): string {
  return splitLongTextSegmentByDisplayWidth(value, Math.max(width, 1))[0] ?? "";
}

function trimLineEnd(line: ChatBodyLine): ChatBodyLine {
  const next = [...line];
  while (next.length > 0) {
    const last = next[next.length - 1]!;
    if (last.kind !== "text") break;
    const trimmed = last.value.trimEnd();
    if (trimmed) {
      next[next.length - 1] = { ...last, value: trimmed };
      break;
    }
    next.pop();
  }
  return next;
}

function wrapInlineContentLine(
  text: string,
  width: number,
  catalog: Record<string, InlineTickerCatalogEntry>,
): ChatBodyLine[] {
  const safeWidth = Math.max(width, 1);
  const lines: ChatBodyLine[] = [];
  let current: ChatBodyLine = [];
  let currentWidth = 0;

  const finishLine = () => {
    lines.push(trimLineEnd(current));
    current = [];
    currentWidth = 0;
  };

  const appendSegment = (token: InlineContentToken, rawValue: string, trimStartOnWrap: boolean) => {
    let value = currentWidth === 0 && trimStartOnWrap ? rawValue.trimStart() : rawValue;
    if (!value) return;

    while (value) {
      const tokenWidth = token.kind === "ticker"
        ? inlineTokenWidth(tokenWithValue(token, value), catalog)
        : displayWidth(value);
      const available = safeWidth - currentWidth;

      if (currentWidth > 0 && tokenWidth > available) {
        if (available <= 0) {
          finishLine();
          if (trimStartOnWrap) value = value.trimStart();
          continue;
        }

        if (token.kind === "ticker") {
          finishLine();
          continue;
        }

        const chunk = firstDisplayWidthChunk(value, Math.max(available, 1));
        if (chunk) {
          current.push(tokenWithValue(token, chunk));
          currentWidth += displayWidth(chunk);
          value = value.slice(chunk.length);
        }
        finishLine();
        if (trimStartOnWrap) value = value.trimStart();
        continue;
      }

      if (tokenWidth <= safeWidth - currentWidth || token.kind === "ticker") {
        current.push(tokenWithValue(token, value));
        currentWidth += tokenWidth;
        return;
      }

      const chunk = firstDisplayWidthChunk(value, Math.max(safeWidth - currentWidth, 1));
      if (chunk) {
        current.push(tokenWithValue(token, chunk));
        currentWidth += displayWidth(chunk);
        value = value.slice(chunk.length);
      }
      finishLine();
      if (trimStartOnWrap) value = value.trimStart();
    }
  };

  const appendTextPart = (rawPart: string) => {
    let part = rawPart;
    const partWidth = displayWidth(part);
    if (currentWidth > 0 && partWidth > safeWidth - currentWidth && partWidth <= safeWidth) {
      finishLine();
      part = part.trimStart();
    }
    appendSegment({ kind: "text", value: part }, part, true);
  };

  const appendText = (value: string) => {
    const parts = value.match(/\S+\s*|\s+/g) ?? [value];
    for (const part of parts) {
      appendTextPart(part);
    }
  };

  const appendInlineToken = (token: InlineContentToken) => {
    const tokenWidth = inlineTokenWidth(token, catalog);
    if (currentWidth > 0 && currentWidth + tokenWidth > safeWidth) finishLine();
    appendSegment(token, token.value, false);
  };

  for (const token of tokenizeInlineContent(text)) {
    if (token.kind === "text") {
      appendText(token.value);
      continue;
    }
    appendInlineToken(token);
  }

  if (current.length > 0 || lines.length === 0) lines.push(trimLineEnd(current));
  return lines;
}

export function getMessageBodyTokenLines(
  text: string,
  width: number,
  catalog: Record<string, InlineTickerCatalogEntry>,
): ChatBodyLine[] {
  const lines: ChatBodyLine[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push([]);
      continue;
    }
    lines.push(...wrapInlineContentLine(paragraph, width, catalog));
  }
  return lines.length > 0 ? lines : [[]];
}

export function getMessageBodyLines(
  message: ChatMessage,
  width: number,
  catalog?: Record<string, InlineTickerCatalogEntry>,
) {
  const contentLineWidth = Math.max(width - 4, 1);
  if (catalog) return getMessageBodyTokenLines(message.content, contentLineWidth, catalog).map((line) => line.map((token) => token.value).join(""));
  return wrapTextLines(message.content, contentLineWidth);
}

export function estimateMessageHeight(
  message: ChatMessage,
  width: number,
  grouped = false,
  catalog?: Record<string, InlineTickerCatalogEntry>,
) {
  const headerHeight = grouped ? 0 : 1;
  const contentLineWidth = Math.max(width - 4, 1);
  const bodyLineCount = catalog
    ? getMessageBodyTokenLines(message.content, contentLineWidth, catalog).length
    : getMessageBodyLines(message, width, catalog).length;
  return headerHeight + (message.replyTo ? 1 : 0) + bodyLineCount;
}

export function estimateComposerHeight(text: string, width: number) {
  return Math.max(1, Math.min(CHAT_COMPOSER_MAX_ROWS, wrapTextLines(text, width).length));
}

export function getMessageTopOffset(
  messages: ChatMessage[],
  index: number,
  width: number,
  catalog?: Record<string, InlineTickerCatalogEntry>,
) {
  let offset = 0;
  for (let i = 0; i < index; i += 1) {
    offset += estimateMessageHeight(messages[i]!, width, isGroupedWithPrevious(messages, i), catalog);
  }
  return offset;
}

export function hasPixelScrollMetrics(scrollBox: ScrollBoxRenderable | null) {
  return !!scrollBox?.scrollToPixels && typeof scrollBox.scrollHeightPx === "number" && !!scrollBox.viewportPx;
}

export function getScrollTop(scrollBox: ScrollBoxRenderable, preferPixels: boolean) {
  return preferPixels && typeof scrollBox.scrollTopPx === "number" ? scrollBox.scrollTopPx : scrollBox.scrollTop;
}

export function getScrollHeight(scrollBox: ScrollBoxRenderable, preferPixels: boolean) {
  return preferPixels && typeof scrollBox.scrollHeightPx === "number" ? scrollBox.scrollHeightPx : scrollBox.scrollHeight;
}

function getViewportHeight(scrollBox: ScrollBoxRenderable, preferPixels: boolean) {
  return preferPixels && scrollBox.viewportPx ? scrollBox.viewportPx.height : scrollBox.viewport?.height ?? 0;
}

export function scrollToPosition(scrollBox: ScrollBoxRenderable, target: number, preferPixels: boolean) {
  if (preferPixels && scrollBox.scrollToPixels) {
    scrollBox.scrollToPixels(target);
    return;
  }
  scrollBox.scrollTo(target);
}

export function scrollToBottom(scrollBox: ScrollBoxRenderable | null, preferPixels = false) {
  if (!scrollBox) return;
  const exactPixels = preferPixels && hasPixelScrollMetrics(scrollBox);
  scrollToPosition(
    scrollBox,
    Math.max(0, getScrollHeight(scrollBox, exactPixels) - getViewportHeight(scrollBox, exactPixels)),
    exactPixels,
  );
}

export function isScrolledToBottom(scrollBox: ScrollBoxRenderable | null, preferPixels = false) {
  if (!scrollBox) return true;
  const exactPixels = preferPixels && hasPixelScrollMetrics(scrollBox);
  const scrollTop = getScrollTop(scrollBox, exactPixels);
  const maxScrollTop = Math.max(0, getScrollHeight(scrollBox, exactPixels) - getViewportHeight(scrollBox, exactPixels));
  const threshold = exactPixels ? SCROLL_BOTTOM_THRESHOLD_PX : 0;
  return maxScrollTop - scrollTop <= threshold;
}

export function runAfterLayout(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  queueMicrotask(callback);
}

function getScrollTopForElementIntoView({
  scrollTop,
  viewportHeight,
  elementTop,
  elementHeight,
  bottomInset = 0,
}: {
  scrollTop: number;
  viewportHeight: number;
  elementTop: number;
  elementHeight: number;
  bottomInset?: number;
}) {
  const visibleHeight = Math.max(viewportHeight - bottomInset, 1);
  const elementBottom = elementTop + elementHeight;
  if (elementTop < scrollTop || elementHeight >= visibleHeight) return elementTop;
  if (elementBottom > scrollTop + visibleHeight) return elementBottom - visibleHeight;
  return scrollTop;
}

export function scrollElementIntoScrollBoxView(scrollBox: ScrollBoxRenderable | null, node: unknown) {
  const nodeRect = (node as { getBoundingClientRect?: () => { x?: number; y?: number; top?: number; width?: number; height?: number } } | null)
    ?.getBoundingClientRect?.();
  const scrollRect = scrollBox?.getBoundingClientRect?.() as { x?: number; y?: number; top?: number; width?: number; height?: number } | undefined;
  if (
    scrollBox &&
    nodeRect &&
    scrollRect &&
    scrollBox.scrollToPixels &&
    typeof scrollBox.scrollTopPx === "number" &&
    scrollBox.viewportPx
  ) {
    const nodeY = nodeRect.y ?? nodeRect.top ?? 0;
    const scrollY = scrollRect.y ?? scrollRect.top ?? 0;
    const elementTop = scrollBox.scrollTopPx + nodeY - scrollY;
    const nextScrollTop = getScrollTopForElementIntoView({
      scrollTop: scrollBox.scrollTopPx,
      viewportHeight: scrollBox.viewportPx.height,
      elementTop,
      elementHeight: Math.max(nodeRect.height ?? 0, 1),
    });
    if (nextScrollTop !== scrollBox.scrollTopPx) {
      scrollBox.scrollToPixels(nextScrollTop);
    }
    return true;
  }

  const scrollIntoView = (node as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView;
  if (typeof scrollIntoView !== "function") return false;
  scrollIntoView.call(node, { block: "nearest", inline: "nearest" });
  return true;
}

export function getSelectedMessageScrollTop({
  scrollTop,
  viewportHeight,
  top,
  rowHeight,
  bottomInset = MESSAGE_SELECTION_BOTTOM_INSET,
}: {
  scrollTop: number;
  viewportHeight: number;
  top: number;
  rowHeight: number;
  bottomInset?: number;
}) {
  const safeViewportHeight = Math.max(viewportHeight, 1);
  const visibleMessageRows = Math.max(safeViewportHeight - bottomInset, 1);
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + visibleMessageRows) {
    return Math.max(top + rowHeight - visibleMessageRows, 0);
  }
  return scrollTop;
}
