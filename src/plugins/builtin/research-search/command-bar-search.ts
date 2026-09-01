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
  hitTypeLabel,
  researchSearchInstanceId,
  RESEARCH_SEARCH_TEMPLATE_ID,
} from "./model";
import { parseMarkedSnippet } from "./snippet";

/** Enough hits to judge whether the corpus has the answer, few enough to scan. */
const COMMAND_BAR_HIT_LIMIT = 3;

function hitResultDef(hit: CloudSearchHit, openPane: (hit: CloudSearchHit) => void): CommandBarResultDef {
  const segments = parseMarkedSnippet(hit.snippet).map((segment) => ({
    text: segment.text,
    emphasis: segment.marked ? "match" as const : undefined,
  }));
  return {
    id: hit.id,
    label: hit.title,
    detail: [hitTypeLabel(hit), formatHitDate(hit.publishedAt)].filter(Boolean).join(" · "),
    right: hit.ticker,
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
     * Below every ticker category (-40 to -10) and below Ask AI, so navigation
     * and exact matches still lead. Above the default 0 that generic command and
     * pane matches use, because those are fuzzy: "nvidia earnings" pulls in
     * Treasury Auctions and Dividend Yield, and at a positive priority the real
     * hits sorted beneath that noise and fell outside the panel's 16-row body
     * entirely, so nothing was visible without scrolling.
     */
    priority: -5,
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
          { query, limit: COMMAND_BAR_HIT_LIMIT, count: false },
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
          right: "RSCH",
          execute: () => openSearchPane(query),
        },
      ];
    },
  };
}
