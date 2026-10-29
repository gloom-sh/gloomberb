import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import type { InstrumentSearchResult } from "../../../types/instrument";
import type { PaneTemplateDef, PinTickerOptions } from "../../../types/plugin";
import type { TickerRecord } from "../../../types/ticker";
import { LISTING_SEARCH_LIMIT } from "../../../tickers/search";
import { CommandBarHarness } from "./test-harness";

const tui = createOpenTuiTestHarness();
const delisting = { status: "inactive" as const, lastTradeDate: "2022-03-14", historyStart: "2016-01-04" };
const listings: Record<string, InstrumentSearchResult[]> = {
  HFC: [
    { providerId: "test", symbol: "HFC", name: "Hampton Financial Corporation", exchange: "TSXV", currency: "CAD", type: "EQUITY" },
    { providerId: "test", symbol: "HFC", name: "HollyFrontier Corporation", exchange: "NYSE", currency: "USD", type: "EQUITY", delisting },
    { providerId: "test", symbol: "HFC", name: "HF Company", exchange: "FWB2", currency: "EUR", type: "EQUITY" },
  ],
  SAN: [
    { providerId: "test", symbol: "SAN", name: "Sanofi", exchange: "EPA", currency: "EUR", type: "EQUITY" },
    { providerId: "test", symbol: "SAN", name: "Banco Santander", exchange: "NYSE", currency: "USD", type: "EQUITY" },
  ],
};

// Before its search answers, a typed ticker command opens the listing the shared
// resolver reads (DES HFC is the former US line, as `quote HFC` reads it). Once
// rows are up, Enter opens exactly the highlighted one: search relevance leads
// with another company here, and that is the row Enter opens.
for (const suggestionsReady of [false, true]) {
  for (const [query, expectedSymbol, expectedExchange, expectedName] of [
    ["DES HFC", "HFC", "NYSE", "HollyFrontier Corporation"],
    ["DES HFC:NYSE", "HFC:XNYS", "NYSE", "HollyFrontier Corporation"],
    ["DES SAN", "SAN", "NYSE", "Banco Santander"],
    ["HFC", "HFC", "NYSE", "HollyFrontier Corporation"],
  ] as const) {
    // A plain root query offers no ticker row until its search answers.
    if (!suggestionsReady && query === "HFC") continue;
    const symbol = query.replace(/^DES /, "").split(":")[0]!;
    // The highlighted row once the answer is in: the first, unless the query named the venue.
    const highlighted = !suggestionsReady || query.includes(":") ? { exchange: expectedExchange, name: expectedName }
      : { exchange: listings[symbol]![0]!.exchange, name: listings[symbol]![0]!.name };
    test(`${query} with suggestions ${suggestionsReady ? "loaded opens the highlighted row" : "pending resolves the typed listing"}`, async () => {
      const opened: string[] = [];
      const saved: TickerRecord[] = [];
      const { promise: held, resolve: releaseSuggestions } = Promise.withResolvers<void>();
      await tui.render(<CommandBarHarness
        query={query}
        live
        onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
        configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
        dataProvider={createTestDataProvider({
          search: async (_query, context) => {
            if (!suggestionsReady && context?.limit === LISTING_SEARCH_LIMIT) await held;
            return listings[symbol]!;
          },
          getQuote: async () => createTestQuote({
            symbol, name: expectedName, listingExchangeName: "NYSE", currency: "USD",
            ...(symbol === "HFC" ? { delisting } : {}),
          }),
        })}
      />, { width: 110, height: 28 });
      try {
        if (suggestionsReady) await tui.waitForFrameToContain(symbol === "HFC" ? "Hampton Financial" : "Sanofi");
        else await tui.setup().renderOnce();
        await tui.emitKeypress({ name: "return", sequence: "\r" });
        await tui.waitForFrameToContain("bar:closed");
        expect(opened).toEqual([suggestionsReady ? symbol : expectedSymbol]);
        expect(saved.at(-1)?.metadata).toMatchObject({ exchange: highlighted.exchange, name: highlighted.name });
      } finally {
        releaseSuggestions();
      }
    });
  }
}

test("a late answer that reorders the rows moves the highlight with its row, and Enter opens that row", async () => {
  const opened: string[] = [];
  const saved: TickerRecord[] = [];
  const { promise: fresh, resolve: answerFresh } = Promise.withResolvers<void>();
  const [hampton, holly, hf] = listings.HFC!;
  let answers = 0;
  await tui.render(<CommandBarHarness
    query=""
    live
    onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
    configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
    dataProvider={createTestDataProvider({
      search: async (query, context) => {
        if (context?.limit !== LISTING_SEARCH_LIMIT || query.toUpperCase() !== "HFC") return [];
        answers += 1;
        if (answers === 1) return listings.HFC!;
        // The fresher answer lists HollyFrontier first.
        await fresh;
        return [holly!, hampton!, hf!];
      },
    })}
  />, { width: 110, height: 28 });
  await act(async () => { await tui.setup().mockInput.typeText("HFC"); });
  await tui.waitForFrameToContain("Hampton Financial");
  // Back to HFC: the cached answer is up at once, Hampton highlighted, while the fresher search is out.
  await tui.emitKeypress({ name: "backspace" });
  await tui.waitForFrameToExclude("Hampton Financial");
  await act(async () => { await tui.setup().mockInput.typeText("C"); });
  await tui.waitForFrameToContain("Hampton Financial");
  answerFresh();
  for (let attempt = 0; attempt < 50; attempt++) {
    const frame = tui.frame();
    if (frame.indexOf("HollyFrontier") >= 0 && frame.indexOf("HollyFrontier") < frame.indexOf("Hampton")) break;
    await tui.renderFrames(1);
    await Bun.sleep(10);
  }
  expect(tui.frame().indexOf("HollyFrontier")).toBeLessThan(tui.frame().indexOf("Hampton"));
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["HFC"]);
  expect(saved.at(-1)?.metadata).toMatchObject({ exchange: "TSXV", name: "Hampton Financial Corporation" });
});

test.each(["DES HFC", "HFC"])("Shift+Enter on untouched %s opens the highlighted listing in a new pane", async (query) => {
  const opened: Array<{ symbol: string; options?: PinTickerOptions }> = [];
  const saved: TickerRecord[] = [];
  await tui.render(<CommandBarHarness
    query={query}
    live
    onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
    configurePluginRegistry={(registry) => {
      registry.pinTicker = (symbol, options) => { opened.push({ symbol, options }); };
    }}
    dataProvider={createTestDataProvider({
      search: async () => listings.HFC!,
      getQuote: async () => createTestQuote({ symbol: "HFC", listingExchangeName: "NYSE", delisting }),
    })}
  />, { width: 110, height: 28 });
  await tui.waitForFrameToContain("Hampton Financial");
  await tui.emitKeypress({ name: "return", sequence: "\r", shift: true });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual([{ symbol: "HFC", options: expect.objectContaining({ forceNewPane: true }) }]);
  expect(saved.at(-1)?.metadata).toMatchObject({ ticker: "HFC", exchange: "TSXV", name: "Hampton Financial Corporation" });
});

test.each(["keyboard", "mouse"] as const)("an explicit %s choice still opens the foreign listing", async (input) => {
  const opened: string[] = [];
  const saved: TickerRecord[] = [];
  await tui.render(<CommandBarHarness
    query="DES HFC"
    live
    onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
    configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
    dataProvider={createTestDataProvider({
      search: async () => listings.HFC!,
      getQuote: async () => createTestQuote({ symbol: "HFC", listingExchangeName: "NYSE", delisting }),
    })}
  />, { width: 110, height: 28 });
  await tui.waitForFrameToContain("Hampton Financial");
  if (input === "mouse") {
    await tui.clickFrameText("Hampton Financial");
  } else {
    // Moving away and back deliberately selects the first suggestion.
    await tui.emitKeypress({ name: "down" });
    await tui.emitKeypress({ name: "up" });
    await tui.emitKeypress({ name: "return", sequence: "\r" });
  }
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["HFC"]);
  expect(saved.at(-1)?.metadata).toMatchObject({ ticker: "HFC", exchange: "TSXV", name: "Hampton Financial Corporation" });
});

test.each(["DES Microsoft", "Microsoft"])("%s still opens the leading company-name result", async (query) => {
  const opened: string[] = [];
  await tui.render(<CommandBarHarness
    query={query}
    live
    configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
    dataProvider={createTestDataProvider({
      search: async () => [{ providerId: "test", symbol: "MSFT", name: "Microsoft Corp.", exchange: "NASDAQ", currency: "USD", type: "EQUITY" }],
    })}
  />, { width: 110, height: 28 });
  await tui.waitForFrameToContain("MSFT");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["MSFT"]);
});

test.each([
  ["DES HFC:", "TSXV", "Hampton Financial Corporation"],
  ["HFC:", "TSXV", "Hampton Financial Corporation"],
  ["DES HFC:N", "NYSE", "HollyFrontier Corporation"],
  ["HFC:N", "NYSE", "HollyFrontier Corporation"],
] as const)("%s accepts the highlighted venue on the first Enter", async (query, exchange, name) => {
  const opened: string[] = [];
  const saved: TickerRecord[] = [];
  await tui.render(<CommandBarHarness
    query={query}
    live
    onAction={(action) => { if (action.type === "UPDATE_TICKER") saved.push(action.ticker); }}
    configurePluginRegistry={(registry) => { registry.pinTicker = (key) => { opened.push(key); }; }}
    dataProvider={createTestDataProvider({ search: async () => listings.HFC! })}
  />, { width: 110, height: 28 });
  await tui.waitForFrameToContain(name.split(" ").slice(0, 2).join(" "));
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(opened).toEqual(["HFC"]);
  expect(saved.at(-1)?.metadata).toMatchObject({ exchange, name });
});

test("a typed BR function opens Brokers even when BR is a saved ticker", async () => {
  const panes: string[] = [];
  const tickers: string[] = [];
  await tui.render(<CommandBarHarness
    query=""
    live
    extraTickers={[createTestTicker("BR", "Broadridge Financial Solutions")]}
    configurePluginRegistry={(registry) => {
      (registry.paneTemplates as Map<string, PaneTemplateDef>).set("brokers-pane", {
        id: "brokers-pane", paneId: "brokers", label: "Brokers",
        description: "Open broker profiles and connection status",
        shortcut: { prefix: "BR" },
      });
      registry.createPaneFromTemplateAsync = async (id) => { panes.push(id); };
      registry.pinTicker = (symbol) => { tickers.push(symbol); };
    }}
  />, { width: 110, height: 28 });
  await act(async () => { await tui.setup().mockInput.typeText("BR"); });
  await tui.waitForFrameToContain("Shortcut: Brokers");
  await tui.emitKeypress({ name: "return", sequence: "\r" });
  await tui.waitForFrameToContain("bar:closed");
  expect(panes).toEqual(["brokers-pane"]);
  expect(tickers).toEqual([]);
});
