import type { ScrollBoxRenderable } from "../../../ui";
import type { ChatMessage } from "../../../api-client";
import { splitLongTextSegmentByDisplayWidth, truncateWithEllipsis } from "../../../utils/text-wrap";
import { parseMarkdownLines } from "../../../utils/markdown";
import { displayWidth } from "../../../utils/format";
import {
  formatTickerBadgePrice,
  getTickerBadgeText,
  TICKER_BADGE_CHROME_WIDTH,
  type TickerBadgeStatus,
} from "../../../components/ticker/badge/format";
import type { InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";
import { STICKY_BOTTOM_THRESHOLD_PX } from "../../../ui/sticky-scroll";
import { terminalReactionRows } from "./reactions";
import { chatMessagePaneLinks } from "./pane-links/model";
import { chatInlineTokens, type ChatInlineToken, type ChatTextStyle } from "./markdown";

const MESSAGE_GROUP_THRESHOLD_MS = 5 * 60 * 1000;
const MESSAGE_SELECTION_BOTTOM_INSET = 1;

export const CHAT_COMPOSER_MAX_ROWS = 5;
export const MESSAGE_ACTION_WIDTH = 9;
export const COMPOSER_ACTION_WIDTH = 10;

export function isGroupedWithPrevious(messages: ChatMessage[], index: number) {
  if (index === 0) return false;
  const prev = messages[index - 1]!;
  const curr = messages[index]!;
  if (prev.user.id !== curr.user.id) return false;
  // An announcement is a card of its own, with its own header.
  if (prev.announcement || curr.announcement) return false;
  // The Discord tag sits on a header, so a linked person's Discord and app messages do not share one.
  if ((prev.origin === "discord") !== (curr.origin === "discord")) return false;
  return new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime() < MESSAGE_GROUP_THRESHOLD_MS;
}

export function normalizeInlinePreview(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function formatInlinePreview(text: string, width: number) {
  return truncateWithEllipsis(normalizeInlinePreview(text), width);
}

/** One row of a message in the terminal: its tokens, already wrapped to the body's width. */
export type ChatBodyLine = ChatInlineToken[];

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
 * is wrapped from the first one, so the width covers the widest day change.
 * Terminal lines render the chip with this as its `maxTextWidth`, so a move
 * past it drops detail instead of spilling into the next token. It also still
 * covers the symbol and price with one more integer digit, which chips once
 * grew to under the pointer, so transcripts keep wrapping where they did; a
 * hovered chip now keeps its resting width.
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
      widths.push(displayWidth(`${symbol} ${formatTickerBadgePrice({ ...quote, price })}`));
    }
  }
  return Math.max(...widths);
}

function inlineTokenWidth(
  token: ChatInlineToken,
  catalog: Record<string, InlineTickerCatalogEntry>,
): number {
  if (token.kind !== "ticker") return displayWidth(token.value);

  const entry = catalog[token.symbol];
  if (!entry || entry.status === "missing") return displayWidth(token.value);

  // A live chip's change and price move with every tick; reserving their
  // widest forms keeps the wrapped lines (and the scroll offsets) stable.
  return chatBadgeTextWidth(token.symbol, entry) + TICKER_BADGE_CHROME_WIDTH;
}

function tokenWithValue(token: ChatInlineToken, value: string): ChatInlineToken {
  return { ...token, value };
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

function sameStyle(a: ChatTextStyle | undefined, b: ChatTextStyle | undefined): boolean {
  return !!a?.bold === !!b?.bold && !!a?.italic === !!b?.italic && !!a?.strike === !!b?.strike
    && !!a?.code === !!b?.code && !!a?.muted === !!b?.muted;
}

/** Neighbouring words of one style draw as one run. */
function joinTextTokens(line: ChatBodyLine): ChatBodyLine {
  const joined: ChatBodyLine = [];
  for (const token of line) {
    const previous = joined[joined.length - 1];
    if (token.kind === "text" && previous?.kind === "text" && sameStyle(previous.style, token.style)) {
      joined[joined.length - 1] = { ...previous, value: previous.value + token.value };
    } else {
      joined.push(token);
    }
  }
  return joined;
}

function wrapInlineTokens(
  tokens: readonly ChatInlineToken[],
  width: number,
  catalog: Record<string, InlineTickerCatalogEntry>,
): ChatBodyLine[] {
  const safeWidth = Math.max(width, 1);
  const lines: ChatBodyLine[] = [];
  let current: ChatBodyLine = [];
  let currentWidth = 0;

  const finishLine = () => {
    lines.push(joinTextTokens(trimLineEnd(current)));
    current = [];
    currentWidth = 0;
  };

  const appendSegment = (token: ChatInlineToken, rawValue: string, trimStartOnWrap: boolean) => {
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

  const appendTextPart = (token: ChatInlineToken, rawPart: string) => {
    let part = rawPart;
    const partWidth = displayWidth(part);
    if (currentWidth > 0 && partWidth > safeWidth - currentWidth && partWidth <= safeWidth) {
      finishLine();
      part = part.trimStart();
    }
    appendSegment(token, part, true);
  };

  const appendText = (token: ChatInlineToken) => {
    const parts = token.value.match(/\S+\s*|\s+/g) ?? [token.value];
    for (const part of parts) {
      appendTextPart(token, part);
    }
  };

  const appendInlineToken = (token: ChatInlineToken) => {
    const tokenWidth = inlineTokenWidth(token, catalog);
    if (currentWidth > 0 && currentWidth + tokenWidth > safeWidth) finishLine();
    appendSegment(token, token.value, false);
  };

  for (const token of tokens) {
    if (token.kind === "text") {
      appendText(token);
      continue;
    }
    appendInlineToken(token);
  }

  if (current.length > 0 || lines.length === 0) finishLine();
  return lines;
}

const QUOTE_BAR: ChatInlineToken = { kind: "text", value: "\u2502 ", style: { muted: true } };

/** Each wrapped row starts with `first` or, after the first, `rest`: a list item's marker and the hang under it, a quote's bar. */
function withPrefix(lines: ChatBodyLine[], first: ChatInlineToken, rest: ChatInlineToken): ChatBodyLine[] {
  return lines.map((line, index) => [index === 0 ? first : rest, ...line]);
}

/** A line of a code block, as written, broken where the row ends. */
function codeRows(text: string, width: number): ChatBodyLine[] {
  const value = text.replace(/\t/g, "  ");
  if (!value) return [[]];
  return splitLongTextSegmentByDisplayWidth(value, Math.max(width, 1))
    .map((chunk): ChatBodyLine => [{ kind: "text", value: chunk, style: { code: true } }]);
}

/**
 * A message's rows in the terminal: its markdown read line by line (a heading
 * bold, a list item's later rows hung under its text, a quote barred on every
 * row, a code block as written) and wrapped to `width`.
 */
export function getMessageBodyTokenLines(
  text: string,
  width: number,
  catalog: Record<string, InlineTickerCatalogEntry>,
): ChatBodyLine[] {
  const lines: ChatBodyLine[] = [];
  for (const line of parseMarkdownLines(text)) {
    switch (line.kind) {
      case "blank":
        lines.push([]);
        break;
      case "code":
        lines.push(...codeRows(line.text, width));
        break;
      case "heading":
        lines.push(...wrapInlineTokens(
          chatInlineTokens(line.text).map((token) => ({ ...token, style: { ...token.style, bold: true } })),
          width,
          catalog,
        ));
        break;
      case "quote":
        lines.push(...withPrefix(wrapInlineTokens(chatInlineTokens(line.text), width - 2, catalog), QUOTE_BAR, QUOTE_BAR));
        break;
      case "list": {
        const marker = `${" ".repeat(line.indent)}${/^\d/.test(line.marker) ? line.marker : "\u2022"} `;
        const markerWidth = displayWidth(marker);
        lines.push(...withPrefix(
          wrapInlineTokens(chatInlineTokens(line.text), width - markerWidth, catalog),
          { kind: "text", value: marker, style: { muted: true } },
          { kind: "text", value: " ".repeat(markerWidth) },
        ));
        break;
      }
      case "text":
        lines.push(...wrapInlineTokens(chatInlineTokens(line.text), width, catalog));
        break;
    }
  }
  return lines.length > 0 ? lines : [[]];
}

export function estimateMessageHeight(
  message: ChatMessage,
  width: number,
  grouped = false,
  catalog?: Record<string, InlineTickerCatalogEntry>,
) {
  const headerHeight = grouped ? 0 : 1;
  const contentLineWidth = Math.max(width - 4, 1);
  const imageCount = message.attachments?.length ?? 0;
  // A chip row for each share link or Wire post link, in place of the link's text.
  const { links, content } = chatMessagePaneLinks(message);
  // The terminal draws a row per image and one for a review note; an image-only message has no text row.
  const bodyLineCount = content.length === 0 && (imageCount > 0 || links.length > 0)
    ? 0
    : getMessageBodyTokenLines(content, contentLineWidth, catalog ?? {}).length;
  const reviewNoteHeight = message.attachmentReview ? 1 : 0;
  const reactionRows = message.reactions?.length ? terminalReactionRows(message.reactions, contentLineWidth).length : 0;
  return headerHeight + (message.replyTo ? 1 : 0) + bodyLineCount + links.length + imageCount + reviewNoteHeight + reactionRows;
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
  if (preferPixels && scrollBox.scrollToEnd) {
    scrollBox.scrollToEnd();
    return;
  }
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
  const threshold = exactPixels ? STICKY_BOTTOM_THRESHOLD_PX : 0;
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
  center = false,
}: {
  scrollTop: number;
  viewportHeight: number;
  elementTop: number;
  elementHeight: number;
  bottomInset?: number;
  /** An element out of view is brought to the middle of it, not to the nearest edge. */
  center?: boolean;
}) {
  const visibleHeight = Math.max(viewportHeight - bottomInset, 1);
  const elementBottom = elementTop + elementHeight;
  if (elementHeight >= visibleHeight) return elementTop;
  const outOfView = elementTop < scrollTop || elementBottom > scrollTop + visibleHeight;
  if (center && outOfView) return Math.max(0, elementTop - (visibleHeight - elementHeight) / 2);
  if (elementTop < scrollTop) return elementTop;
  if (elementBottom > scrollTop + visibleHeight) return elementBottom - visibleHeight;
  return scrollTop;
}

export function scrollElementIntoScrollBoxView(
  scrollBox: ScrollBoxRenderable | null,
  node: unknown,
  options: { center?: boolean } = {},
) {
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
      center: options.center,
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

/** Where a reader is in the list: at the bottom, or which message is at the top of the view and how far down. */
export interface ScrollPlace {
  atBottom: boolean;
  anchorId: string | null;
  /** In px from the top of the view to the top of the anchor message. */
  anchorOffsetPx: number;
}

function messageRect(node: unknown): { y: number; height: number } | null {
  const rect = (node as { getBoundingClientRect?: () => { y?: number; top?: number; height?: number } } | null)
    ?.getBoundingClientRect?.();
  if (!rect) return null;
  return { y: rect.y ?? rect.top ?? 0, height: rect.height ?? 0 };
}

/**
 * The reader's place in a pixel-scrolled list, to put them back after the list is
 * rebuilt. Null where the list has no pixel layout.
 */
export function readScrollPlace(
  scrollBox: ScrollBoxRenderable | null,
  messages: ChatMessage[],
  elements: Map<string, unknown>,
): ScrollPlace | null {
  const view = scrollBox?.getBoundingClientRect?.();
  if (!scrollBox || !view || !hasPixelScrollMetrics(scrollBox)) return null;
  if (isScrolledToBottom(scrollBox, true)) return { atBottom: true, anchorId: null, anchorOffsetPx: 0 };
  // Only mounted rows have geometry in a windowed list. Their insertion order
  // can differ after scrolling, so pick the highest row that intersects the view.
  if (scrollBox.scrollToItem) {
    let found: { id: string; y: number } | null = null;
    for (const [id, node] of elements) {
      const rect = messageRect(node);
      if (rect && rect.y + rect.height > view.y + 1 && (!found || rect.y < found.y)) found = { id, y: rect.y };
    }
    return found ? { atBottom: false, anchorId: found.id, anchorOffsetPx: found.y - view.y } : null;
  }
  // Rows run down the page in order, so the first with any part in view is found by halving.
  let low = 0;
  let high = messages.length - 1;
  let found: { id: string; y: number } | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const message = messages[middle]!;
    const rect = messageRect(elements.get(message.id));
    if (!rect) return null;
    if (rect.y + rect.height > view.y + 1) {
      found = { id: message.id, y: rect.y };
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found ? { atBottom: false, anchorId: found.id, anchorOffsetPx: found.y - view.y } : null;
}

export function restoreScrollPlace(
  scrollBox: ScrollBoxRenderable | null,
  place: ScrollPlace,
  elements: Map<string, unknown>,
) {
  if (!place.atBottom && place.anchorId && scrollBox?.scrollToItem?.(place.anchorId, { align: "start", offset: place.anchorOffsetPx })) return;
  const view = scrollBox?.getBoundingClientRect?.();
  const rect = place.anchorId ? messageRect(elements.get(place.anchorId)) : null;
  if (!scrollBox || !view || place.atBottom || !rect || typeof scrollBox.scrollTopPx !== "number") {
    scrollToBottom(scrollBox, true);
    return;
  }
  scrollToPosition(scrollBox, scrollBox.scrollTopPx + (rect.y - view.y) - place.anchorOffsetPx, true);
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
