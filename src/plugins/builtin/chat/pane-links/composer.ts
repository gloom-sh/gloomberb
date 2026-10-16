import { paneShareIdFromUrl } from "../../../../shares/location";
import { MAX_SHARE_CHIPS, type ChatMessagePaneLink } from "./model";

/** A share link waiting in the composer, drawn as the chip the sent message will show. */
export type ComposerShareLink = Extract<ChatMessagePaneLink, { kind: "share" }>;

export interface ComposerDraftView {
  /** What the message field holds. */
  text: string;
  /** The share links drawn as chips above it. */
  links: ComposerShareLink[];
}

/** Between the text and each link, as Share has always posted a link under its caption. */
const BLOCK_GAP = "\n\n";

/** A whole segment that is one Gloom share link and nothing else. */
function shareLinkSegment(segment: string): ComposerShareLink | null {
  if (!segment || /\s/.test(segment)) return null;
  const id = paneShareIdFromUrl(segment);
  return id ? { kind: "share", id, url: segment } : null;
}

/**
 * The composer's view of a saved draft: the share links at its end, each a
 * block of its own after a blank line, become chips, and the rest is the
 * field's text. `joinComposerDraft` writes the view back; the two undo each
 * other exactly, so a draft read back from storage never changes what is
 * being typed. A link anywhere else in the text stays text.
 */
export function splitComposerDraft(draft: string): ComposerDraftView {
  const links: ComposerShareLink[] = [];
  let rest = draft;
  while (links.length < MAX_SHARE_CHIPS) {
    const gap = rest.lastIndexOf(BLOCK_GAP);
    const link = shareLinkSegment(gap < 0 ? rest : rest.slice(gap + BLOCK_GAP.length));
    if (!link) break;
    links.unshift(link);
    rest = gap < 0 ? "" : rest.slice(0, gap);
    if (gap < 0) break;
  }
  return { text: rest, links };
}

/** The draft saved for a view: the text, then each link after a blank line. */
export function joinComposerDraft(text: string, links: readonly ComposerShareLink[]): string {
  return [text, ...links.map((link) => link.url)].filter((part) => part !== "").join(BLOCK_GAP);
}

/**
 * The composer's view of a draft the chat hands it: the view on screen when
 * the draft is the one that view saves (its own draft coming back with an
 * arriving message, say), else the draft read afresh. Text the person typed
 * that ends in a share link stays text in the field while they write.
 */
export function composerViewOfDraft(draft: string, current: ComposerDraftView): ComposerDraftView {
  return draft === joinComposerDraft(current.text, current.links) ? current : splitComposerDraft(draft);
}

/**
 * The message a draft sends, in the form every app reads: the text, then each
 * link after a blank line, which apps that draw chips turn back into chips
 * and older ones show as the link.
 */
export function composerMessage(text: string, links: readonly ComposerShareLink[]): string {
  return joinComposerDraft(text.trim(), links);
}

/**
 * The chips a paste becomes, or null when it stays text exactly as pasted.
 * Only one share link and nothing else, landing at the end of the draft or in
 * an empty field, becomes a chip; a link pasted inside a sentence or with
 * words of its own stays where it was put, so the message reads as written.
 * A share that already has a chip adds none, and past the chips a message
 * draws, the link stays text.
 */
export function pastedShareChips(
  pasted: string,
  textAfter: string,
  existing: readonly ComposerShareLink[],
): ComposerShareLink[] | null {
  if (textAfter.trim()) return null;
  const link = shareLinkSegment(pasted.trim());
  if (!link) return null;
  if (existing.some((chip) => chip.id === link.id)) return [];
  return existing.length < MAX_SHARE_CHIPS ? [link] : null;
}
