import type { GloomPlugin, PaneTemplateCreateOptions } from "../../../types/plugin";
import { attachResearchSearchPersistence, resetResearchSearchPersistence } from "./data";
import { RESEARCH_SEARCH_PANE_ID, RESEARCH_SEARCH_TEMPLATE_ID } from "./model";
import { ResearchSearchPane } from "./pane";

const description =
  "Full-text search across earnings call transcripts, news wires, and SEC filings, with saved searches and keyword alerts.";

function queryFromOptions(options?: PaneTemplateCreateOptions): string {
  return (options?.arg ?? options?.values?.query ?? "").trim();
}

export const researchSearchPlugin: GloomPlugin = {
  id: "research-search",
  name: "Research Search",
  version: "1.0.0",
  description,
  toggleable: true,

  setup(ctx) {
    attachResearchSearchPersistence(ctx.persistence);
  },

  dispose() {
    resetResearchSearchPersistence();
  },

  panes: [
    {
      id: RESEARCH_SEARCH_PANE_ID,
      name: "Research Search",
      icon: "RS",
      component: ResearchSearchPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 118, height: 32 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: RESEARCH_SEARCH_TEMPLATE_ID,
      paneId: RESEARCH_SEARCH_PANE_ID,
      label: "Research Search",
      description,
      keywords: [
        "search",
        "documents",
        "full text",
        "transcripts",
        "calls",
        "news",
        "filings",
        "sec",
        "alerts",
        "saved search",
      ],
      shortcut: {
        prefix: "RSCH",
        argPlaceholder: "query",
        argKind: "text",
        argOptional: true,
      },
      createInstance(_context, options) {
        const query = queryFromOptions(options);
        return {
          // One pane per query, so two searches can sit side by side.
          instanceId: query
            ? `${RESEARCH_SEARCH_PANE_ID}:${encodeURIComponent(query).replace(/%/g, "~")}`
            : `${RESEARCH_SEARCH_PANE_ID}:main`,
          title: query ? `Search ${query}` : "Research Search",
          placement: "floating",
          settings: { query },
        };
      },
    },
  ],
};
