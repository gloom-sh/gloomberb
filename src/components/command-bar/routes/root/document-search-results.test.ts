import { describe, expect, test } from "bun:test";
import type { PaneTemplateDef } from "../../../../types/plugin";
import type { ResultItem } from "../../list/model";
import { orderListResults } from "../../list/model";
import {
  buildDocumentSearchResultItem,
  DOCUMENT_SEARCH_ITEM_ID,
  DOCUMENT_SEARCH_TEMPLATE_ID,
} from "./document-search-results";
import { buildRootResultModel, type RootResultModelOptions } from "./results";

const searchTemplate = {
  id: DOCUMENT_SEARCH_TEMPLATE_ID,
  paneId: "research-search",
  label: "Research Search",
  description: "Search documents",
  shortcut: { prefix: "RSCH", argPlaceholder: "query", argKind: "text" },
} as unknown as PaneTemplateDef;

function documentSearchItem(query: string): ResultItem | null {
  return buildDocumentSearchResultItem({
    query,
    templates: [searchTemplate],
    createPaneTemplateItem: (template, options) => ({
      id: `pane-template:${template.id}`,
      label: template.label,
      detail: template.description,
      category: "Panes",
      kind: "action",
      searchText: options?.createOptions?.arg ?? "",
      action: () => {},
    }),
  });
}

function rootOptions(overrides: Partial<RootResultModelOptions>): RootResultModelOptions {
  const empty = () => [] as ResultItem[];
  return {
    activeCollectionId: null,
    activeTickerData: null,
    activeTickerSymbol: null,
    assist: null,
    availableCommands: [],
    buildLayoutItems: empty,
    buildPaneSettingItems: empty,
    buildWindowModeItems: empty,
    createPaneTemplateItem: () => ({
      id: "template",
      label: "Template",
      detail: "",
      category: "Panes",
      kind: "action",
      action: () => {},
    }),
    createPluginCommandItem: () => ({
      id: "plugin-command",
      label: "Plugin Command",
      detail: "",
      category: "Commands",
      kind: "command",
      action: () => {},
    }),
    currentRoute: null,
    executeCollectionCommand: () => {},
    getAvailablePaneShortcutTemplates: () => [],
    hasPaneSettings: () => false,
    localTickerSearchResultItems: empty,
    nonShortcutPaneTemplateItems: empty,
    openModeRoute: () => {},
    paneShortcutItems: empty,
    pluginCommandItems: empty,
    pluginCommandResultItems: empty,
    rootQuery: "",
    rootShortcutIntent: { kind: "none" },
    runDirectCommand: () => {},
    runSecurityDescriptionShortcut: () => {},
    state: {
      config: { watchlists: [], portfolios: [] },
      focusedPaneId: null,
    } as unknown as RootResultModelOptions["state"],
    tickerActionItems: empty,
    ...overrides,
  };
}

const paneRow: ResultItem = {
  id: "pane-template:margin-monitor",
  label: "Margin Monitor",
  detail: "Track account margin",
  category: "Panes",
  kind: "action",
  action: () => {},
};

describe("buildDocumentSearchResultItem", () => {
  test("carries the typed words into the pane the template opens", () => {
    const item = documentSearchItem("margin pressure");
    expect(item?.id).toBe(DOCUMENT_SEARCH_ITEM_ID);
    expect(item?.label).toBe('Search all documents for "margin pressure"');
    expect(item?.right).toBe("RSCH");
    expect(item?.searchText).toBe("margin pressure");
  });

  test("stays hidden for a single keystroke or a missing plugin", () => {
    expect(documentSearchItem("m")).toBeNull();
    expect(buildDocumentSearchResultItem({
      query: "margin",
      templates: [],
      createPaneTemplateItem: () => {
        throw new Error("should not build an item without the template");
      },
    })).toBeNull();
  });
});

describe("document search fallthrough placement", () => {
  test("lands after existing matches instead of displacing them", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "margin",
      paneShortcutItems: () => [paneRow],
      documentSearchItem: documentSearchItem("margin"),
    }));

    const ordered = orderListResults(items);
    expect(ordered.map((item) => item.id)).toEqual([paneRow.id, DOCUMENT_SEARCH_ITEM_ID]);
  });

  test("stays out of the way once a prefix claims the query", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "SEC AAPL",
      documentSearchItem: documentSearchItem("SEC AAPL"),
      rootShortcutIntent: {
        kind: "complete",
        source: "pane-template",
        prefix: "SEC",
        label: "SEC",
        description: "",
        argKind: "ticker",
        argText: "AAPL",
        completionQuery: null,
        template: searchTemplate,
      },
    }));

    expect(items.map((item) => item.id)).not.toContain(DOCUMENT_SEARCH_ITEM_ID);
  });
});
