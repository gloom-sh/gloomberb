import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatAttachment } from "../../../../api-client";
import { chatMessageTokens } from "../markdown";
import { chatImageLabel } from "../attachments/model";
import { wirePaneTarget, type ChatMessagePaneLink } from "../pane-links/model";
import { chatPaneLinkPane, peekSharePreview } from "../pane-links/previews";

export type ChatOpenTarget =
  | { kind: "pane"; link: ChatMessagePaneLink; label: string }
  | { kind: "ticker"; symbol: string }
  | { kind: "link"; url: string; label: string }
  | { kind: "image"; index: number; url: string; label: string };

/** What the Open list calls a chip: the share's title once read, else its link; a Wire post's pane. */
function paneLinkLabel(link: ChatMessagePaneLink): string {
  if (link.kind === "share") {
    const preview = peekSharePreview(link.id);
    return preview.status === "ready" ? preview.title : link.url;
  }
  const target = wirePaneTarget(link.link);
  const name = chatPaneLinkPane(target.paneId)?.name ?? target.name;
  return target.day ? `${name} · ${target.day}` : name;
}

/**
 * What a message lets you open, in reading order: its chips (the panes its
 * share links and Wire link open), the ticker badges its text draws (a symbol
 * the catalog does not know stays plain text), its links, then its images.
 * `content` is the text the message draws, without the links its chips stand
 * for. Code is text, so nothing in it is offered.
 */
export function chatMessageOpenTargets(
  content: string,
  catalog: Record<string, InlineTickerCatalogEntry>,
  attachments: readonly ChatAttachment[] = [],
  paneLinks: readonly ChatMessagePaneLink[] = [],
): ChatOpenTarget[] {
  const targets: ChatOpenTarget[] = paneLinks.map((link) => ({ kind: "pane", link, label: paneLinkLabel(link) }));
  const seen = new Set<string>();
  // The link just listed: a label with marks in it ("[the **keys**](url)") is several tokens of one link.
  let open: Extract<ChatOpenTarget, { kind: "link" }> | null = null;
  for (const token of chatMessageTokens(content)) {
    if (token.kind === "link" && open?.url === token.url) {
      open.label += token.value;
      continue;
    }
    open = null;
    if (token.kind === "ticker") {
      const entry = catalog[token.symbol];
      if (!entry || entry.status === "missing" || seen.has(`ticker:${token.symbol}`)) continue;
      seen.add(`ticker:${token.symbol}`);
      targets.push({ kind: "ticker", symbol: token.symbol });
    } else if (token.kind === "link" && !seen.has(`link:${token.url}`)) {
      seen.add(`link:${token.url}`);
      open = { kind: "link", url: token.url, label: token.value };
      targets.push(open);
    }
  }
  attachments.forEach((attachment, index) => {
    const label = chatImageLabel(attachment);
    targets.push({
      kind: "image",
      index,
      url: attachment.url,
      label: `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
    });
  });
  return targets;
}
