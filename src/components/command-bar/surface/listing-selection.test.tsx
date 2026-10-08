import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider } from "../../../test-support/data-provider";
import type { CommandDef, PaneTemplateCreateOptions, PaneTemplateDef } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import type { AppState } from "../../../state/app/context";
import { CommandBarHarness, createCommandBarTestControls } from "./test-harness";
import { createTestTicker } from "../../../test-support/ticker";

const tui = createOpenTuiTestHarness();
const { waitForFrameToContain } = createCommandBarTestControls(() => tui.setup());

for (const savedDefault of [false, true]) {
  test(`EE listing choice preserves TSX identity with ${savedDefault ? "a saved Nasdaq default" : "an unavailable default quote"}`, async () => {
    const created: Array<{ templateId: string; options?: PaneTemplateCreateOptions }> = [];
    const searchQueries: string[] = [];
    await tui.render(<CommandBarHarness
      query="EE SHOP"
      live
      extraTickers={savedDefault ? [createTestTicker("SHOP", "Shopify Inc.")] : []}
      dataProvider={createTestDataProvider({
        search: async (query) => {
          searchQueries.push(query);
          return [
            { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" },
            { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "TSX", currency: "CAD", type: "EQUITY" },
          ];
        },
        getQuote: async () => { throw new Error("Default quote unavailable"); },
      })}
      configurePluginRegistry={(registry) => {
        (registry.paneTemplates as Map<string, PaneTemplateDef>).set("earnings-estimates", {
          id: "earnings-estimates", paneId: "quote-monitor", label: "Earnings Estimates",
          description: "Research earnings estimates", shortcut: { prefix: "EE", argKind: "ticker" },
        });
        registry.createPaneFromTemplateAsync = async (templateId, options) => { created.push({ templateId, options }); };
      }}
    />, { width: 100, height: 24 });
    await tui.setup().renderOnce();
    // Enter must resolve an ambiguity; Tab deliberately selects another listing
    // even when a saved default could be opened without prompting.
    await tui.emitKeypress(savedDefault ? { name: "tab" } : { name: "return", sequence: "\r" });
    await waitForFrameToContain("TSX");
    await tui.emitKeypress({ name: "down" });
    const queriesBeforeChoice = searchQueries.length;
    await tui.emitKeypress({ name: "return", sequence: "\r", shift: savedDefault });
    await act(async () => { await Bun.sleep(20); });
    await tui.setup().renderOnce();
    expect(created).toHaveLength(1);
    expect(created[0]?.templateId).toBe("earnings-estimates");
    expect(created[0]?.options?.symbol).toBe("SHOP:XTSE");
    expect(created[0]?.options?.ticker?.metadata).toMatchObject({ ticker: "SHOP:XTSE", exchange: "TSX", currency: "CAD" });
    expect(searchQueries).toHaveLength(queriesBeforeChoice);
    expect(tui.frame()).toContain("Search or run a command");
  });
}

test("watchlist listing selection consumes the chosen record without re-searching its bare symbol", async () => {
  const saved: TickerRecord[] = [];
  let rejectFurtherSearch = false;
  await tui.render(<CommandBarHarness
    query="AW SHOP" live onSaveTicker={(ticker) => saved.push(ticker)}
    configureState={(state) => ({ ...state, paneState: { "portfolio-list:main": { collectionId: "watchlist" } } })}
    dataProvider={createTestDataProvider({
      search: async () => {
        if (rejectFurtherSearch) throw new Error("Search is no longer available");
        return [
          { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" },
          { providerId: "test", symbol: "SHOP", name: "Shopify Inc.", exchange: "TSX", currency: "CAD", type: "EQUITY" },
        ];
      },
    })}
  />, { width: 100, height: 24 });
  await tui.setup().renderOnce();
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await waitForFrameToContain("TSX");
  await tui.emitKeypress({ name: "down" });
  rejectFurtherSearch = true;
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await act(async () => { await Bun.sleep(20); });
  await tui.setup().renderOnce();
  expect(saved.at(-1)?.metadata).toMatchObject({ ticker: "SHOP:XTSE", exchange: "TSX", currency: "CAD", watchlists: ["watchlist"] });
  expect(tui.frame()).toContain("Search or run a command");
});

const addListingLaunch = (state: AppState): AppState => ({
  ...state,
  commandBarLaunchRequest: { kind: "add-listing" as const, collectionId: "watchlist", collectionKind: "watchlist" as const, sequence: 1 },
});

test.each(["NET:", "T:", "T:N"])("a venue picked from an add row's %s list joins that watchlist", async (query) => {
  const symbol = query.split(":")[0]!;
  const saved: TickerRecord[] = [];
  const opened: string[] = [];
  await tui.render(<CommandBarHarness
    query={query}
    live
    onSaveTicker={(ticker) => saved.push(ticker)}
    configureState={addListingLaunch}
    configurePluginRegistry={(registry) => {
      registry.createPaneFromTemplate = () => { opened.push("pane"); };
      registry.pinTicker = () => { opened.push("pin"); };
    }}
    dataProvider={createTestDataProvider({
      search: async () => [
        { providerId: "test", symbol, name: "US listing", exchange: "NYSE", currency: "USD", type: "EQUITY" },
        { providerId: "test", symbol, name: "UK listing", exchange: "LSE", currency: "GBP", type: "EQUITY" },
      ],
    })}
  />, { width: 100, height: 24 });
  await waitForFrameToContain("NYSE");
  const filtered = query.endsWith(":N");
  if (filtered) {
    expect(tui.frame()).not.toContain("LSE");
  } else {
    expect(tui.frame()).toContain("LSE");
    await tui.emitKeypress({ name: "down" });
  }
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await act(async () => { await Bun.sleep(20); });
  await tui.setup().renderOnce();
  expect(saved.at(-1)?.metadata).toMatchObject({
    exchange: filtered ? "NYSE" : "LSE",
    name: filtered ? "US listing" : "UK listing",
    watchlists: ["watchlist"],
  });
  expect(opened).toEqual([]);
  expect(tui.frame()).toContain("Search or run a command");
});

test.each(["T", "NET"])("%s colon search bypasses matching command labels and filters venues as typing continues", async (symbol) => {
  const searches: string[] = [];
  const quotes: string[] = [];
  const opened: string[] = [];
  await tui.render(<CommandBarHarness
    query={`${symbol}:`}
    live
    configurePluginRegistry={(registry) => {
      (registry.commands as Map<string, CommandDef>).set("symbol-label", {
        id: "symbol-label", label: symbol, keywords: [`${symbol}:`],
        description: "Matching local action", category: "plugins", execute: async () => {},
      });
      registry.pinTicker = (ticker) => { opened.push(ticker); };
    }}
    dataProvider={createTestDataProvider({
      search: async (query) => {
        searches.push(query);
        return [
          { providerId: "test", symbol, name: "Example", exchange: "NYSE", currency: "USD", type: "EQUITY" },
          { providerId: "test", symbol, name: "Example", exchange: "LSE", currency: "GBP", type: "EQUITY" },
        ];
      },
      getQuote: async (query) => { quotes.push(query); throw new Error("No quote needed to list venues"); },
    })}
  />, { width: 100, height: 24 });
  await waitForFrameToContain("LSE");
  expect(tui.frame()).not.toContain("Matching local action");
  await act(async () => { await tui.setup().mockInput.typeText("N"); });
  await tui.waitForFrameToExclude("LSE");
  expect(tui.frame()).toContain("NYSE");
  expect(searches).toEqual([symbol]);
  expect(quotes).toEqual([]);
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  expect(opened).toEqual([symbol]);
});

test.each(["", "F", "T", "T AAPL"])("%j preserves ordinary empty, one-letter and command search behavior", async (query) => {
  const searches: string[] = [];
  await tui.render(<CommandBarHarness
    query={query}
    dataProvider={createTestDataProvider({ search: async (text) => { searches.push(text); return []; } })}
  />);
  await act(async () => { await Bun.sleep(260); });
  await tui.setup().renderOnce();
  expect(searches).toEqual(query === "T AAPL" ? ["AAPL"] : []);
  expect(tui.frame()).not.toContain("Searching");
});

test("other text in a bar opened from an add row runs as usual", async () => {
  const saved: TickerRecord[] = [];
  const opened: string[] = [];
  await tui.render(<CommandBarHarness
    query="DES AAPL"
    live
    onSaveTicker={(ticker) => saved.push(ticker)}
    configureState={addListingLaunch}
    configurePluginRegistry={(registry) => {
      registry.pinTicker = (symbol) => { opened.push(symbol); };
    }}
    dataProvider={createTestDataProvider({ search: async () => [] })}
  />, { width: 100, height: 24 });
  await waitForFrameToContain("NASDAQ");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await act(async () => { await Bun.sleep(20); });
  await tui.setup().renderOnce();
  expect(opened).toEqual(["AAPL"]);
  expect(saved.filter((ticker) => ticker.metadata.watchlists.includes("watchlist"))).toEqual([]);
});
