import type { CloudSearchHit } from "../../../api-client";
import type {
  CommandBarResultDef,
  CommandBarSearchProvider,
  GloomPluginContext,
} from "../../../types/plugin";
import { apiClient } from "../../../api-client";
import { runDocumentSearch } from "./data";
import { requestDocumentFocus } from "./focus-handoff";
import {
  formatHitDate,
  formatHitDateShort,
  hitLeadIn,
  hitTypeLabel,
  researchSearchInstanceId,
  RESEARCH_SEARCH_TEMPLATE_ID,
} from "./model";
import { parseMarkedSnippet } from "./snippet";

/**
 * Each hit costs two rows (title, then source and snippet), and the sheet now
 * takes about half the terminal rather than a fixed sixteen rows, so six fits
 * without pushing the sections below it off screen.
 */
const COMMAND_BAR_HIT_LIMIT = 6;

export function hitResultDef(
  hit: CloudSearchHit,
  openPane: (hit: CloudSearchHit) => void,
  now = Date.now(),
): CommandBarResultDef {
  const leadIn = [hitLeadIn(hit), hit.ticker].filter(Boolean).join(" · ");
  const snippet = parseMarkedSnippet(hit.snippet).map((segment) => ({
    text: segment.text,
    emphasis: segment.marked ? "match" as const : undefined,
  }));
  // Source and ticker open the snippet line, so the right column is free for
  // the date, which is what decides whether a hit is still worth reading.
  const segments = leadIn
    ? [{ text: `${leadIn} · `, emphasis: "muted" as const }, ...snippet]
    : snippet;
  return {
    id: hit.id,
    label: hit.title,
    detail: [leadIn, formatHitDate(hit.publishedAt)].filter(Boolean).join(" · "),
    // NEWS, CALL, or the filing form.
    badge: hitTypeLabel(hit),
    right: formatHitDateShort(hit.publishedAt, now),
    lines: segments.length > 0 ? [{ segments }] : undefined,
    keywords: [hit.ticker, hitTypeLabel(hit)],
    execute: () => openPane(hit),
  };
}

/**
 * Full-text document hits for free text the command bar could not resolve. The
 * corpus is remote and Pro-gated, so every failure — including the 402 an
 * unentitled account gets — degrades to no rows at all: the command bar is not
 * the place to learn that a background search you never asked for went wrong.
 */
export function createDocumentSearchProvider(ctx: GloomPluginContext): CommandBarSearchProvider {
  const openSearchPane = (query: string) => {
    ctx.createPaneFromTemplate(RESEARCH_SEARCH_TEMPLATE_ID, { arg: query });
  };

  return {
    id: "research-search:documents",
    category: "Documents",
    /**
     * Async sections sit below every synchronous one, ordered by how long they
     * take to arrive, so a late arrival only ever pushes rows below itself and
     * never the rows the eye is already on. Instruments answer in ~200ms,
     * documents in ~400ms, Ask AI later still; the view model pins those bands
     * at 100, 200 and 300 and this is the middle one.
     */
    priority: 200,
    minQueryLength: 3,
    debounceMs: 350,

    async provide(query, _context, signal) {
      // Only skip when there is no session at all, so a signed-out bar does not
      // spend a request per query to be told so. Deliberately not gated on the
      // cached user's plan: that cache is cleared whenever a session refresh
      // comes back empty, which leaves the app authenticated for every other
      // surface while reporting itself signed out here. Entitlement is the
      // server's answer anyway, and it already returns 401, 402, or a delayed
      // result on its own.
      if (!apiClient.isSignedIn()) return [];

      let hits: CloudSearchHit[] = [];
      try {
        const response = await runDocumentSearch(
          // One row per story: three matching paragraphs of one article is one
          // result, and the teaser has three rows to spend.
          { query, limit: COMMAND_BAR_HIT_LIMIT, count: false, distinct: true },
          signal,
        );
        hits = response.hits ?? [];
      } catch {
        return [];
      }

      return [
        ...hits.map((hit) => hitResultDef(hit, (target) => {
          openSearchPane(query);
          requestDocumentFocus(researchSearchInstanceId(query), target);
        })),
        {
          id: "search-all",
          label: "Search all documents \u2192",
          detail: "Earnings calls, news, and SEC filings",
          badge: "DOCS",
          right: "RSCH",
          execute: () => openSearchPane(query),
        },
      ];
    },
  };
}
