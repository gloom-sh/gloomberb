import type { ChatMessage, ChatPaneLink } from "../../../../api-client";
import { paneShareIdFromUrl } from "../../../../shares/location";
import { tokenizeInlineLinks } from "../../../../utils/link-tokenizer";
import { formatShortDate } from "../../../../utils/datetime-format";

/**
 * Something a message opens in the terminal, drawn as a chip under its text:
 * a Gloom share link someone posted, or what a Gloom Wire post names in its
 * `paneLink` (never read out of the post's text).
 */
export type ChatMessagePaneLink =
  | { kind: "share"; id: string; url: string }
  | { kind: "wire"; link: ChatPaneLink };

export interface ChatMessagePaneLinks {
  links: ChatMessagePaneLink[];
  /**
   * The text to draw: the message's own, less the share links its chips stand
   * for and the publisher address an older news post still ends in.
   */
  content: string;
}

/** A message rarely carries more; past this the rest stay plain links. */
export const MAX_SHARE_CHIPS = 3;
const NONE: ChatMessagePaneLinks = { links: [], content: "" };
const memo = new WeakMap<object, ChatMessagePaneLinks>();

/**
 * The text without the given link tokens (their indexes in
 * `tokenizeInlineLinks`). A line that held nothing but such links goes with
 * them, and so does a blank line left doubled where it stood.
 */
export function withoutLinks(content: string, drop: ReadonlySet<number>): string {
  const lines: Array<{ text: string; removed: boolean }> = [{ text: "", removed: false }];
  let dropped = false;
  tokenizeInlineLinks(content).forEach((token, index) => {
    const line = lines[lines.length - 1]!;
    if (drop.has(index)) {
      line.removed = true;
      dropped = true;
      return;
    }
    // "see <link> for" reads "see for", not "see  for"; "<link> for" reads "for".
    const value = dropped && (!line.text || /[ \t]$/.test(line.text)) ? token.value.replace(/^[ \t]+/, "") : token.value;
    dropped = false;
    const [first, ...rest] = value.split("\n");
    line.text += first;
    for (const text of rest) lines.push({ text, removed: false });
  });
  const kept: string[] = [];
  let afterRemoved = false;
  for (const line of lines) {
    const text = line.text.trimEnd();
    if (line.removed && !text.trim()) {
      afterRemoved = kept.length === 0 || !kept[kept.length - 1];
      continue;
    }
    if (!text && afterRemoved) continue;
    afterRemoved = false;
    kept.push(text);
  }
  while (kept.length > 0 && !kept[0]) kept.shift();
  while (kept.length > 0 && !kept[kept.length - 1]) kept.pop();
  return kept.join("\n");
}

/**
 * Gloom Wire news posts used to end in the publisher's article address, on a
 * line of their own. A story opens in Gloom now, so for a post whose `paneLink`
 * names one that line is neither drawn nor offered by Open. Only that last line
 * goes, and only when it is nothing but one web address; the story is never
 * read out of the address, and a message with no `paneLink` is left as written.
 */
function withoutLegacyArticleLink(content: string): string {
  const lines = content.trimEnd().split("\n");
  if (lines.length < 2 || !/^https?:\/\/\S+$/i.test(lines[lines.length - 1]!.trim())) return content;
  return lines.slice(0, -1).join("\n").trimEnd() || content;
}

function computePaneLinks(message: Pick<ChatMessage, "content" | "paneLink">): ChatMessagePaneLinks {
  const content = message.paneLink?.kind === "news-story" ? withoutLegacyArticleLink(message.content) : message.content;
  const links: ChatMessagePaneLink[] = [];
  const drop = new Set<number>();
  // Cheap guard: the tokenizer only runs on messages that could hold a share link.
  if (content.includes("gloom.sh")) {
    const seen = new Set<string>();
    tokenizeInlineLinks(content).forEach((token, index) => {
      if (token.kind !== "link") return;
      const id = paneShareIdFromUrl(token.url);
      if (!id) return;
      if (seen.has(id)) {
        drop.add(index);
        return;
      }
      if (seen.size >= MAX_SHARE_CHIPS) return;
      seen.add(id);
      drop.add(index);
      links.push({ kind: "share", id, url: token.url });
    });
  }
  if (message.paneLink) links.push({ kind: "wire", link: message.paneLink });
  if (links.length === 0) return { links: [], content };
  return { links, content: drop.size > 0 ? withoutLinks(content, drop) : content };
}

/**
 * The chips a message draws and the text left beside them. A message with
 * none keeps its text exactly, so plain messages render as before.
 */
export function chatMessagePaneLinks(message: Pick<ChatMessage, "content" | "paneLink"> | null | undefined): ChatMessagePaneLinks {
  if (!message) return NONE;
  const cached = memo.get(message);
  if (cached) return cached;
  const result = computePaneLinks(message);
  memo.set(message, result);
  return result;
}

/** The pane a Wire post opens and how to open it: one of the app's own pane templates. */
export interface WirePaneTarget {
  paneId: string;
  templateId: string;
  /** The pane's name when this build does not register it, so a chip is never blank. */
  name: string;
  arg?: string;
  /** The day it is about, as the chip shows it. */
  day: string | null;
}

export function wirePaneTarget(link: ChatPaneLink): WirePaneTarget {
  const day = (date: string) => formatShortDate(`${date}T12:00:00Z`, { year: false, utc: true });
  switch (link.kind) {
    case "news-story":
      return { paneId: "news-story", templateId: "news-story-pane", name: "Story", arg: link.storyId, day: null };
    case "economic-calendar":
      return { paneId: "econ-calendar", templateId: "econ-calendar-pane", name: "Economic Calendar", day: day(link.date) };
    case "earnings-calendar":
      return { paneId: "earnings-calendar", templateId: "earnings-board-pane", name: "Earnings Calendar", day: day(link.date) };
    case "ipo-calendar":
      return { paneId: "ipo-calendar", templateId: "ipo-calendar-pane", name: "IPO Calendar", day: day(link.date) };
    case "energy-report":
      return {
        paneId: "doe",
        templateId: link.report === "gas" ? "doe-gas-pane" : "doe-pane",
        name: "Oil and Gas Inventories",
        day: day(link.weekEnding),
      };
  }
}
