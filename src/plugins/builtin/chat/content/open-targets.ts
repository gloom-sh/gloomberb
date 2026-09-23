import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import { tokenizeInlineContent } from "../../../../utils/inline-content-tokenizer";

export type ChatOpenTarget =
  | { kind: "ticker"; symbol: string }
  | { kind: "link"; url: string; label: string };

/**
 * What a message body lets you open, in reading order: the ticker badges it
 * draws (a symbol the catalog does not know stays plain text) and its links.
 */
export function chatMessageOpenTargets(
  content: string,
  catalog: Record<string, InlineTickerCatalogEntry>,
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
  return targets;
}
