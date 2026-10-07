import { describe, expect, test } from "bun:test";
import type { PaneTemplateDef } from "../../../../types/plugin";
import { orderListResults, type ResultItem } from "../../list/model";
import { PLUGIN_INSTALL_CATEGORY } from "../../view-model";
import { mergePlainRootTickerResults } from "../ticker-search/results";
import { buildRootResultModel, type RootResultModelOptions } from "./results";

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

const documentRow: ResultItem = {
  id: "search-provider:research-search:documents:hit-1",
  label: "Q3 earnings call",
  detail: "CALL",
  category: "Documents",
  kind: "action",
  lines: [{ segments: [{ text: "margin pressure", emphasis: "match" }] }],
  action: () => {},
};

describe("provider rows in the root result model", () => {
  test("land after the local matches instead of displacing them", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "margin",
      paneShortcutItems: () => [paneRow],
      providerResultItems: [documentRow],
    }));

    expect(orderListResults(items).map((item) => item.id)).toEqual([paneRow.id, documentRow.id]);
  });

  test("leave the local matches alone when a provider contributes nothing", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "margin",
      paneShortcutItems: () => [paneRow],
      providerResultItems: [],
    }));

    expect(items.map((item) => item.id)).toEqual([paneRow.id]);
  });

  test("an exact ticker stays ahead of the News, Filings and Documents sections", () => {
    const tickerRow: ResultItem = {
      id: "ticker:AAPL",
      label: "AAPL",
      detail: "Apple Inc.",
      category: "Search Results",
      kind: "ticker",
      right: "NASDAQ",
      action: () => {},
    };
    const storyRow: ResultItem = {
      id: "search-provider:news:loaded-stories:story-1",
      label: "AAPL guides higher",
      detail: "Wire",
      category: "News",
      kind: "action",
      action: () => {},
    };
    const filingRow: ResultItem = {
      id: "search-provider:sec:filings:0000320193-25-000079",
      label: "Annual Report",
      detail: "Apple Inc.",
      badge: "10-K",
      category: "Filings",
      kind: "action",
      action: () => {},
    };
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "AAPL",
      providerResultItems: [documentRow, filingRow, storyRow],
    }));
    const ordered = orderListResults(mergePlainRootTickerResults("AAPL", [tickerRow], items), {
      sectionOrder: "app-first",
      categoryPriorities: new Map([["News", 190], ["Filings", 195], ["Documents", 200]]),
    });

    expect(ordered[0]).toMatchObject({ id: tickerRow.id, category: "Exact Match" });
    expect(ordered.map((item) => item.id)).toEqual([tickerRow.id, storyRow.id, filingRow.id, documentRow.id]);
  });

  test("stay out of the way once a prefix claims the query", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "SEC AAPL",
      providerResultItems: [documentRow],
      rootShortcutIntent: {
        kind: "complete",
        source: "pane-template",
        prefix: "SEC",
        label: "SEC",
        description: "",
        argKind: "ticker",
        argText: "AAPL",
        completionQuery: null,
        template: { id: "sec-pane" } as unknown as PaneTemplateDef,
      },
    }));

    expect(items.map((item) => item.id)).not.toContain(documentRow.id);
  });
});

describe("assist rows in the root result model", () => {
  const assist = {
    enabled: true,
    auto: true,
    state: { status: "idle" as const },
    onAsk: () => {},
    onSignUp: () => {},
    onRunCandidate: () => {},
  };

  test("lead the list ahead of provider rows and keep the Thinking placeholder", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "margin",
      assist,
      paneShortcutItems: () => [paneRow],
      providerResultItems: [documentRow],
    }));

    expect(orderListResults(items, { categoryPriorities: new Map([["Documents", 200]]) }).map((item) => item.id))
      .toEqual(["assist:pending", paneRow.id, documentRow.id]);
  });

  test("the local matcher no longer drags in panes whose keywords scatter the letters", () => {
    const optionsRow: ResultItem = {
      id: "pane-template:options-calculator",
      label: "Options Calculator",
      detail: "Price options with the Black-Scholes model and view the Greeks",
      searchText: "options greeks implied volatility derivatives pricing",
      category: "Panes",
      kind: "action",
      action: () => {},
    };
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "nvidia",
      paneShortcutItems: () => [optionsRow],
    }));
    expect(items).toEqual([]);

    const { items: abbreviated } = buildRootResultModel(rootOptions({
      rootQuery: "opt calc",
      paneShortcutItems: () => [optionsRow],
    }));
    expect(abbreviated.map((item) => item.id)).toEqual([optionsRow.id]);
  });
});

describe("the plugin install row in the root result model", () => {
  const installRow: ResultItem = {
    id: "plugin-install:prediction-markets:PM",
    label: "Prediction Markets",
    detail: "Event markets",
    category: PLUGIN_INSTALL_CATEGORY,
    kind: "action",
    right: "PM",
    action: () => {},
  };

  test("leads without claiming the query, so the AI and provider rows stay below it", () => {
    const { items } = buildRootResultModel(rootOptions({
      rootQuery: "PM",
      assist: {
        enabled: true,
        auto: true,
        state: { status: "idle" as const },
        onAsk: () => {},
        onSignUp: () => {},
        onRunCandidate: () => {},
      },
      pluginInstallItem: installRow,
      providerResultItems: [documentRow],
    }));

    expect(orderListResults(items, { categoryPriorities: new Map([["Documents", 200]]) }).map((item) => item.id))
      .toEqual([installRow.id, "assist:pending", documentRow.id]);
  });
});

describe("recents in the root result model", () => {
  const newsTemplate = {
    id: "ticker-news-pane",
    paneId: "ticker-news",
    label: "Ticker News",
    description: "News for one ticker",
    shortcut: { prefix: "CN", argKind: "ticker" },
  } as PaneTemplateDef;
  const recentPanes = [
    { id: "pane-template:ticker-news-pane", label: "Ticker News", arg: "MSFT" },
    { id: "pane-template:ticker-news-pane", label: "Ticker News" },
  ];
  const stateWith = (recentTickers: string[], recentCommands: unknown[]) => ({
    focusedPaneId: null,
    config: { watchlists: [], portfolios: [], recentCommands },
    recentTickers,
  }) as unknown as RootResultModelOptions["state"];
  const recentState = stateWith(["AAPL"], recentPanes);
  const tickerRow = (symbol: string): ResultItem => ({
    id: `ticker:${symbol}`,
    label: symbol,
    detail: "",
    category: "Exact Match",
    kind: "ticker",
    action: () => {},
  });
  const templateRow = (template: PaneTemplateDef, options?: { createOptions?: { arg?: string } }): ResultItem => ({
    id: `pane-template:${template.id}`,
    label: template.label,
    detail: template.description ?? "",
    category: "Panes",
    kind: "action",
    right: template.shortcut?.prefix,
    action: () => created.push(options?.createOptions?.arg),
  });
  let created: Array<string | undefined> = [];

  test("an empty bar leads with recent tickers, then recent panes that run again with their ticker", () => {
    created = [];
    const { items } = buildRootResultModel(rootOptions({
      buildRecentTickerItem: tickerRow,
      createPaneTemplateItem: templateRow,
      getRecentPaneTemplate: (id) => (id === newsTemplate.id ? newsTemplate : undefined),
      state: recentState,
    }));

    const recentRows = items.filter((item) => item.category === "Suggested");
    expect(recentRows.map((item) => [item.id, item.label])).toEqual([
      ["ticker:AAPL", "AAPL"],
      ["recent:pane-template:ticker-news-pane:MSFT", "Ticker News MSFT"],
      ["recent:pane-template:ticker-news-pane", "Ticker News"],
    ]);
    expect(orderListResults(items)[0]?.id).toBe("ticker:AAPL");
    recentRows[1]?.action();
    expect(created).toEqual(["MSFT"]);
  });

  test("a typed query drops the recents, and a pane the bar no longer offers is skipped", () => {
    const { items } = buildRootResultModel(rootOptions({
      buildRecentTickerItem: tickerRow,
      createPaneTemplateItem: templateRow,
      rootQuery: "news",
      state: recentState,
    }));
    expect(items.filter((item) => item.category === "Suggested")).toEqual([]);

    // A disabled plugin's template, one that cannot open for the stored
    // ticker, and an entry that is not a pane template.
    const { items: emptyBar } = buildRootResultModel(rootOptions({
      createPaneTemplateItem: templateRow,
      getRecentPaneTemplate: () => undefined,
      state: stateWith([], [...recentPanes, { id: "reset-all-data", label: "Reset All Data" }]),
    }));
    expect(emptyBar.filter((item) => item.category === "Suggested")).toEqual([]);
  });

  test("keeps the section short", () => {
    const { items } = buildRootResultModel(rootOptions({
      buildRecentTickerItem: tickerRow,
      createPaneTemplateItem: templateRow,
      getRecentPaneTemplate: () => newsTemplate,
      state: stateWith(
        ["A", "B", "C", "D", "E", "F"],
        ["A", "B", "C", "D", "E", "F"].map((arg) => ({ id: "pane-template:ticker-news-pane", label: "Ticker News", arg })),
      ),
    }));
    expect(items.filter((item) => item.category === "Suggested").map((item) => item.label)).toEqual([
      "A", "B", "C", "D", "Ticker News A", "Ticker News B", "Ticker News C", "Ticker News D",
    ]);
  });
});
