import { paneShareIdFromUrl } from "../../../../shares/location";
import { tokenizeInlineLinks } from "../../../../utils/link-tokenizer";
import { MAX_SHARE_CHIPS, withoutLinks, type ChatMessagePaneLink } from "./model";

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
 * The message a draft sends, in the form every app reads: the text, then each
 * link after a blank line, which apps that draw chips turn back into chips
 * and older ones show as the link.
 */
export function composerMessage(text: string, links: readonly ComposerShareLink[]): string {
  return joinComposerDraft(text.trim(), links);
}

/**
 * The share links pasted text brings, taken out of it to be chips, and the
 * text left to paste; null when it brings none. A share that already has a
 * chip is not added twice, and past the chips a message draws, a link stays
 * in the text.
 */
export function takePastedShareLinks(pasted: string, existing: readonly ComposerShareLink[]): ComposerDraftView | null {
  if (!pasted.includes("gloom.sh")) return null;
  const seen = new Set(existing.map((link) => link.id));
  const links: ComposerShareLink[] = [];
  const drop = new Set<number>();
  tokenizeInlineLinks(pasted).forEach((token, index) => {
    if (token.kind !== "link") return;
    const id = paneShareIdFromUrl(token.url);
    if (!id) return;
    if (seen.has(id)) {
      drop.add(index);
      return;
    }
    if (existing.length + links.length >= MAX_SHARE_CHIPS) return;
    seen.add(id);
    drop.add(index);
    links.push({ kind: "share", id, url: token.url });
  });
  return drop.size > 0 ? { text: withoutLinks(pasted, drop), links } : null;
}
