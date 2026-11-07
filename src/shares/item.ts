import { markdownPlainText } from "../utils/markdown";
import { isRecord } from "../utils/guards";
import { plainUntrustedLine } from "../utils/untrusted-text";

/**
 * What a shared pane was on when it was shared: the story it had open, the
 * result it had picked, the ticker it shows. It goes with the share, beside
 * the pane's settings, so a chat card, a link preview in another app and the
 * chat's bots can say what the link is about without opening it. A pane on
 * nothing in particular shares none.
 */
export interface ShareItem {
  /** The pane it opens, by name: a reader without that pane (a link preview, a bot) still says which. */
  pane: string;
  title: string;
  /** A sentence or two of what it says: a story's summary, a result's snippet. */
  excerpt?: string;
}

const SHARE_ITEM_LIMITS = { pane: 80, title: 200, excerpt: 300 } as const;
/** About two lines of a chat card and what link previews show of a description. */
const EXCERPT_LENGTH = 240;

/** One line of plain text, as the share service keeps it and every reader draws it (untrusted-text.ts). */
const oneLine = plainUntrustedLine;

/** `text` cut to `max` characters at a word, with an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The opening of a text as one line: its first paragraph, cut to about two lines. */
export function shareItemExcerpt(text: string | null | undefined, { markdown = false, max = EXCERPT_LENGTH } = {}): string | undefined {
  if (!text) return undefined;
  const plain = markdown ? markdownPlainText(text, { links: true }) : text;
  const paragraph = plain.split(/\n\s*\n/).map(oneLine).find(Boolean);
  return paragraph ? clip(paragraph, Math.min(max, SHARE_ITEM_LIMITS.excerpt)) : undefined;
}

/** The item as it is kept: one line each, within the limits, or null without a title. */
export function shareItem(pane: string, part: { title?: string | null; excerpt?: string | null } | null | undefined): ShareItem | null {
  const title = part?.title ? clip(oneLine(part.title), SHARE_ITEM_LIMITS.title) : "";
  const name = clip(oneLine(pane), SHARE_ITEM_LIMITS.pane);
  if (!title || !name) return null;
  const excerpt = part?.excerpt ? clip(oneLine(part.excerpt), SHARE_ITEM_LIMITS.excerpt) : "";
  return { pane: name, title, ...(excerpt && excerpt !== title ? { excerpt } : {}) };
}

/** `value` as one line of plain text within `max`, or null when it is not text, says nothing, or is over. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = oneLine(value);
  return text && text.length <= max ? text : null;
}

/**
 * An item read back from a share, or null for anything else. Another person's
 * app wrote it, so its text is made plain again here, whatever the service
 * kept: no escape sequence, control, bidi or zero-width character reaches a
 * card.
 */
export function parseShareItem(value: unknown): ShareItem | null {
  if (!isRecord(value) || !Object.keys(value).every((key) => key === "pane" || key === "title" || key === "excerpt")) return null;
  const pane = boundedText(value.pane, SHARE_ITEM_LIMITS.pane);
  const title = boundedText(value.title, SHARE_ITEM_LIMITS.title);
  if (!pane || !title) return null;
  if (value.excerpt === undefined) return { pane, title };
  const excerpt = boundedText(value.excerpt, SHARE_ITEM_LIMITS.excerpt);
  return excerpt ? { pane, title, excerpt } : null;
}
