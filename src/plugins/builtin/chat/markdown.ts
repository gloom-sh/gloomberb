import { markdownPlainText, parseInlineMarkdown, parseMarkdownLines, type MarkdownSegment } from "../../../utils/markdown";
import { safeExternalUrl } from "../../../utils/external-url";
import { tokenizeInlineContent, type InlineContentToken } from "../../../utils/inline-content-tokenizer";

/** How a run of message text is drawn. `muted` is the dim of a list marker, a quote's bar or a link's host. */
export interface ChatTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  muted?: boolean;
}

/** Message text, a link, a $TICKER or an @mention, with the marks around it. */
export type ChatInlineToken = InlineContentToken & { style?: ChatTextStyle };

/** A message link opens in the browser, so only a web address is read as one. */
function isChatLinkHref(href: string): boolean {
  return safeExternalUrl(href) !== null;
}

/** A message as one plain line's worth of text: no marks, a link as its label. */
export function chatPlainText(text: string): string {
  return markdownPlainText(text, { links: isChatLinkHref });
}

function segmentStyle(segment: MarkdownSegment): ChatTextStyle | undefined {
  const style: ChatTextStyle = {};
  if (segment.bold) style.bold = true;
  if (segment.italic) style.italic = true;
  if (segment.strike) style.strike = true;
  if (segment.code) style.code = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

function withStyle<T extends InlineContentToken>(token: T, style: ChatTextStyle | undefined): T & { style?: ChatTextStyle } {
  return style ? { ...token, style } : token;
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Whether a link's label names the host it goes to, as a whole name: "x.com" does not name x.co. */
function labelNamesHost(label: string, host: string): boolean {
  const text = label.toLowerCase().replace(/\bwww\./g, "");
  for (let at = text.indexOf(host); at >= 0; at = text.indexOf(host, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text.slice(at + host.length);
    if (!/[a-z0-9.-]/.test(before) && !/^(?:[a-z0-9-]|\.[a-z0-9])/.test(after)) return true;
  }
  return false;
}

/**
 * One line of a message as tokens. A written link (`[label](url)`) shows its
 * label, followed by the host it goes to unless the label already names it,
 * so a label never hides where a link leads. Code is text as written: no
 * links, mentions or tickers in it.
 */
export function chatInlineTokens(text: string): ChatInlineToken[] {
  const segments = parseInlineMarkdown(text, { links: isChatLinkHref });
  const tokens: ChatInlineToken[] = [];
  let label = "";
  segments.forEach((segment, index) => {
    const style = segmentStyle(segment);
    if (segment.link !== undefined) {
      const url = safeExternalUrl(segment.link) ?? segment.link;
      tokens.push(withStyle({ kind: "link", value: segment.text, url }, style));
      label += segment.text;
      // A label with marks in it is several segments of one link.
      if (segments[index + 1]?.link === segment.link) return;
      const host = linkHost(url);
      if (host && !labelNamesHost(label, host)) tokens.push({ kind: "text", value: ` (${host})`, style: { muted: true } });
      label = "";
      return;
    }
    if (segment.code) {
      tokens.push(withStyle({ kind: "text", value: segment.text }, style));
      return;
    }
    for (const token of tokenizeInlineContent(segment.text)) tokens.push(withStyle(token, style));
  });
  return tokens;
}

/** Every token a message draws outside its code blocks, in reading order. */
export function chatMessageTokens(text: string): ChatInlineToken[] {
  return parseMarkdownLines(text).flatMap((line) => line.kind === "blank" || line.kind === "code" ? [] : chatInlineTokens(line.text));
}
