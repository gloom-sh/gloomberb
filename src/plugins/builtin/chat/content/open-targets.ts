import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ChatAttachment } from "../../../../api-client";
import { tokenizeInlineContent } from "../../../../utils/inline-content-tokenizer";
import { chatImageLabel } from "../attachments/model";

export type ChatOpenTarget =
  | { kind: "ticker"; symbol: string }
  | { kind: "link"; url: string; label: string }
  | { kind: "image"; index: number; url: string; label: string };

/**
 * What a message lets you open, in reading order: the ticker badges its text
 * draws (a symbol the catalog does not know stays plain text), its links, then
 * its images.
 */
export function chatMessageOpenTargets(
  content: string,
  catalog: Record<string, InlineTickerCatalogEntry>,
  attachments: readonly ChatAttachment[] = [],
): ChatOpenTarget[] {
  const targets: ChatOpenTarget[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeInlineContent(content)) {
    if (token.kind === "ticker") {
      const entry = catalog[token.symbol];
      if (!entry || entry.status === "missing" || seen.has(`ticker:${token.symbol}`)) continue;
      seen.add(`ticker:${token.symbol}`);
      targets.push({ kind: "ticker", symbol: token.symbol });
    } else if (token.kind === "link" && !seen.has(`link:${token.url}`)) {
      seen.add(`link:${token.url}`);
      targets.push({ kind: "link", url: token.url, label: token.value });
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
