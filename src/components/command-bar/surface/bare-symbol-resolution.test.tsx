import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import type { InstrumentSearchResult } from "../../../types/instrument";
import type { PinTickerOptions } from "../../../types/plugin";
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

// Search relevance can lead with another company even though the bare quote
// identifies the US listing. A delayed suggestion must not change what Enter opens.
for (const suggestionsReady of [false, true]) {
  for (const [query, expectedSymbol, expectedName] of [
    ["DES HFC", "HFC", "HollyFrontier Corporation"],
    ["DES HFC:NYSE", "HFC:XNYS", "HollyFrontier Corporation"],
    ["DES SAN", "SAN", "Banco Santander"],
    ["HFC", "HFC", "HollyFrontier Corporation"],
  ] as const) {
    // A plain root query offers no ticker row until its search answers.
    if (!suggestionsReady && query === "HFC") continue;
    test(`${query} resolves the typed listing with suggestions ${suggestionsReady ? "loaded" : "pending"}`, async () => {
      const symbol = query.replace(/^DES /, "").split(":")[0]!;
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
        expect(opened).toEqual([expectedSymbol]);
        expect(saved.at(-1)?.metadata).toMatchObject({ ticker: expectedSymbol, exchange: "NYSE", name: expectedName });
      } finally {
        releaseSuggestions();
      }
    });
  }
}

test.each(["DES HFC", "HFC"])("Shift+Enter on untouched %s opens the resolved listing in a new pane", async (query) => {
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
  expect(saved.at(-1)?.metadata).toMatchObject({ ticker: "HFC", exchange: "NYSE", name: "HollyFrontier Corporation" });
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
