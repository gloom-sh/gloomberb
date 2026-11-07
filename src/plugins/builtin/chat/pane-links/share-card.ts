import { terminalItemCardRows, type PaneLinkChipContent } from "../../../../components/ui/pane-link-chip";
import type { ChatMessagePaneLink } from "./model";
import { chatPaneLinkPane, peekSharePreview, type SharePreview } from "./previews";

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * What a share's card says: the item its pane was on, a line or two of it, and
 * the pane it opens. Without an item, or with one named as its pane, the pane
 * is said once: its row (with the share's own title when that says more, as
 * `DES SAMPL Options · Research`) under its own description. Before the share
 * is read the card is its link in the room most cards take; once it is gone,
 * its link alone.
 */
export function shareCardContent(url: string, preview: SharePreview): PaneLinkChipContent {
  if (preview.status === "loading") return { title: url, detail: "", icon: "", pending: true };
  if (preview.status !== "ready") return { title: url, detail: "", icon: "" };
  const pane = chatPaneLinkPane(preview.paneId);
  const paneName = pane?.name ?? preview.item?.pane ?? "";
  const icon = pane?.icon ?? "";
  const item = preview.item;
  if (item && !sameName(item.title, paneName)) {
    return { title: item.title, excerpt: item.excerpt ?? "", detail: paneName || preview.title, icon };
  }
  const row = !paneName ? preview.title
    : sameName(preview.title, paneName) ? paneName
      : `${preview.title} · ${paneName}`;
  return { title: "", excerpt: preview.description ?? item?.excerpt ?? "", detail: row, icon };
}

/** The rows a message's chip takes in the terminal at `width`: a share's card as it reads now, or one row. */
export function terminalChatPaneChipRows(link: ChatMessagePaneLink, width: number): number {
  return link.kind === "share" ? terminalItemCardRows(shareCardContent(link.url, peekSharePreview(link.id)), width) : 1;
}
