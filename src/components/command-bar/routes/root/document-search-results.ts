import type { PaneTemplateCreateOptions, PaneTemplateDef } from "../../../../types/plugin";
import type { ResultItem } from "../../list/model";

/** Template id owned by the Research Search plugin. */
export const DOCUMENT_SEARCH_TEMPLATE_ID = "research-search-pane";

export const DOCUMENT_SEARCH_ITEM_ID = "document-search";

/** One character is a keystroke on the way somewhere, not a query. */
const MIN_QUERY_LENGTH = 2;

/**
 * The last-resort row for free text the command bar could not resolve: it takes
 * the typed words to full-text search instead of leaving the user with nothing.
 * Deliberately built as its own row rather than reordering results, so ticker
 * and command matches keep the top of the list.
 */
export function buildDocumentSearchResultItem(options: {
  query: string;
  templates: readonly PaneTemplateDef[];
  createPaneTemplateItem: (
    template: PaneTemplateDef,
    options?: { createOptions?: PaneTemplateCreateOptions; shortcutExecution?: boolean },
  ) => ResultItem;
}): ResultItem | null {
  const query = options.query.trim();
  if (query.length < MIN_QUERY_LENGTH) return null;

  const template = options.templates.find((entry) => entry.id === DOCUMENT_SEARCH_TEMPLATE_ID);
  if (!template) return null;

  const item = options.createPaneTemplateItem(template, {
    createOptions: { arg: query },
    shortcutExecution: true,
  });

  return {
    ...item,
    id: DOCUMENT_SEARCH_ITEM_ID,
    label: `Search all documents for "${query}"`,
    detail: "Earnings calls, news, and SEC filings",
    category: "Documents",
    kind: "action",
    right: template.shortcut?.prefix,
  };
}
