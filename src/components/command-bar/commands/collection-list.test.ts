import { expect, test } from "bun:test";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { EventBus } from "../../../plugins/event-bus";
import type { PluginRegistry } from "../../../plugins/registry";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import type { InstrumentSearchResult } from "../../../types/instrument";
import type { SharedWorkflowDeps } from "../workflow/ops";
import { executeCollectionCommandAction } from "./collection";
import { pastedSymbolList } from "./collection-list";

const LISTINGS: Record<string, Array<{ name: string; exchange: string }>> = {
  NVDA: [{ name: "NVIDIA Corporation", exchange: "NASDAQ" }],
  AMD: [{ name: "Advanced Micro Devices, Inc.", exchange: "NASDAQ" }],
  PLTR: [{ name: "Palantir Technologies Inc.", exchange: "NASDAQ" }],
  PALO: [{ name: "Palo Alto Networks, Inc.", exchange: "NASDAQ" }],
  ALTO: [{ name: "Alto Ingredients, Inc.", exchange: "NASDAQ" }],
  // Only DFS Furniture, in London, lists as DFS now; Discover had it in New York.
  DFS: [{ name: "DFS Furniture plc", exchange: "LSE" }],
  // Garanti lists in Istanbul only, and no US company ever had GARAN.
  GARAN: [{ name: "Turkiye Garanti Bankasi A.S.", exchange: "BIST" }],
  // Two companies, and no quote of the bare code settles which.
  "2222": [{ name: "Kotobuki Spirits Co., Ltd.", exchange: "JPX" }, { name: "Saudi Arabian Oil Co.", exchange: "TADAWUL" }],
};

const dataProvider = createTestDataProvider({
  search: async (query) => {
    // Searching the words of a name finds that company.
    const symbol = query.toUpperCase();
    if (symbol === "PALO ALTO") return [{ providerId: "test", symbol: "PANW", name: "Palo Alto Networks, Inc.", exchange: "NASDAQ", currency: "USD", type: "Common Stock" }] satisfies InstrumentSearchResult[];
    // A vendor's suffix finds the listing on its venue, under the vendor's symbol: GARAN.IS.
    if (symbol.endsWith(".IS")) {
      return (LISTINGS[symbol.slice(0, -3)] ?? []).filter((listing) => listing.exchange === "BIST")
        .map((listing) => ({ providerId: "test", symbol, currency: "TRY", type: "Common Stock", ...listing }));
    }
    return (LISTINGS[symbol] ?? []).map((listing) => ({ providerId: "test", symbol, currency: "USD", type: "Common Stock", ...listing }));
  },
  getQuote: async (symbol, exchange) => {
    const listing = LISTINGS[symbol]?.length === 1 ? LISTINGS[symbol]![0] : LISTINGS[symbol]?.find((entry) => entry.exchange === exchange);
    if (!listing) throw new Error(`Not a ticker: ${symbol}.`);
    return createTestQuote({ symbol, name: listing.name, listingExchangeName: listing.exchange, currency: listing.exchange === "BIST" ? "TRY" : "USD" });
  },
  getTickerChanges: async (symbol) => symbol === "DFS" ? {
    symbol, moved: null, formerly: null, listedName: null, changes: [],
    formerIssuer: { symbol, name: "Discover Financial Services", until: "2025-05-18", successor: { symbol: "COF", name: "Capital One Financial" }, source: null },
  } : null,
});

async function harness(options: { watchlists?: Array<{ id: string; name: string }>; active?: string | null } = {}) {
  const tickerRepository = new JsonTickerRepository();
  // NVDA was added before.
  const saved = createTestTicker("NVDA", "NVIDIA Corporation", { watchlists: ["watchlist"] });
  await tickerRepository.saveTicker(saved);
  const state = createInitialState(createDefaultConfig(":memory:"));
  if (options.watchlists) state.config.watchlists = options.watchlists;
  state.tickers.set("NVDA", saved);
  const events = new EventBus();
  const added: string[] = [];
  events.on("ticker:added", ({ symbol }) => added.push(symbol));
  const deps: SharedWorkflowDeps = {
    tickerRepository, dataProvider, pluginRegistry: { events } as unknown as PluginRegistry,
    getState: () => state,
    dispatch: (action) => { if (action.type === "UPDATE_TICKER") state.tickers.set(action.ticker.metadata.ticker, action.ticker); },
  };
  const notices: Array<{ body: string; type?: string; duration?: number }> = [];
  const routes: unknown[] = [];
  let closed = 0;
  const add = (rawInput: string, explicitTargetId?: string) => executeCollectionCommandAction({
    commandId: "add-watchlist", rawInput, explicitTargetId,
    activeCollectionId: options.active ?? null, activeTickerSymbol: null,
    getState: deps.getState, buildWorkflowDeps: () => deps,
    openModeRoute: (...args) => { routes.push(["mode", ...args]); },
    pushRoute: (route) => { routes.push(route); },
    openAddToPortfolioWorkflow: () => {},
    notify: (body, notice) => { notices.push({ body, ...notice }); },
    closeAll: () => { closed += 1; },
  });
  const watchlistOf = async (symbol: string) => (await tickerRepository.loadTicker(symbol))?.metadata.watchlists ?? null;
  return { add, notices, routes, added, watchlistOf, state, closed: () => closed };
}

test("a pasted list adds every symbol it can, and names each it could not with the reason", async () => {
  const h = await harness();
  await h.add("NVDA, PLTR; ZZZZ\t2222 amd pltr");

  expect(await h.watchlistOf("PLTR")).toEqual(["watchlist"]);
  expect(await h.watchlistOf("AMD")).toEqual(["watchlist"]);
  expect(await h.watchlistOf("ZZZZ")).toBeNull();
  // A code two companies list is not given to either: it is left for the single add to ask.
  expect(await h.watchlistOf("2222")).toBeNull();
  expect(h.state.tickers.get("PLTR")?.metadata.watchlists).toEqual(["watchlist"]);
  expect(h.added.sort()).toEqual(["AMD", "PLTR"]);
  expect(h.notices).toEqual([{
    body: [
      'Watchlist "Watchlist": 2 added, 1 already in the list, 1 not found: ZZZZ; 1 not added: 2222; 1 repeat skipped.',
      "2222: several listings, add it on its own to choose one",
    ].join("\n"),
    type: "info",
    duration: 12_000,
  }]);
  expect(h.closed()).toBe(1);
  expect(h.routes).toEqual([]);
});

test("a list pasted from a European sheet adds its symbols alone, and names its prices and what names nothing", async () => {
  const h = await harness();
  // Before, the decimal comma split each price, and its first half was added as a ticker.
  await h.add("AMD 2.582,52\nPLTR;1.899,21\n$$$\nN/A");
  expect(await h.watchlistOf("AMD")).toEqual(["watchlist"]);
  expect(await h.watchlistOf("PLTR")).toEqual(["watchlist"]);
  expect(h.added.sort()).toEqual(["AMD", "PLTR"]);
  expect(h.notices).toEqual([{
    body: [
      'Watchlist "Watchlist": 2 added; 2 not symbols: $$$, N/A.',
      "Ignored 2 numbers, not symbols: 2.582,52; 1.899,21.",
    ].join("\n"),
    type: "info",
    duration: 12_000,
  }]);
});

test("a list that finds nothing says so, and one that all went in is a quiet success", async () => {
  const h = await harness();
  await h.add("ZZZZ,YYYY");
  expect(h.notices.pop()).toMatchObject({ body: 'Watchlist "Watchlist": 0 added, 2 not found: ZZZZ, YYYY.', type: "error" });
  await h.add("AMD,PLTR");
  expect(h.notices.pop()).toEqual({ body: 'Watchlist "Watchlist": 2 added.', type: "success", duration: undefined });
});

test("spaces alone are a list, unless search knows the words as one company's name", async () => {
  const h = await harness();
  await h.add("palo alto");
  // The name goes to search as it did before, and neither PALO nor ALTO is added.
  expect(h.routes).toEqual([["mode", "ticker-search", "palo alto", { action: "collection-command", commandId: "add-watchlist" }]]);
  expect(await h.watchlistOf("PALO")).toBeNull();
  expect(await h.watchlistOf("ALTO")).toBeNull();
  expect(h.notices).toEqual([]);

  await h.add("AMD PLTR");
  expect(await h.watchlistOf("AMD")).toEqual(["watchlist"]);
  expect(await h.watchlistOf("PLTR")).toEqual(["watchlist"]);
});

test("a list asks which watchlist when none is chosen, and carries the text to the choice", async () => {
  const h = await harness({ watchlists: [{ id: "watchlist", name: "Watchlist" }, { id: "growth", name: "Growth" }] });
  await h.add("AMD, PLTR");
  expect(h.routes).toMatchObject([{ kind: "picker", pickerId: "collection-target", title: "Add 2 tickers to Watchlist", payload: { symbol: "AMD, PLTR" } }]);
  expect(await h.watchlistOf("AMD")).toBeNull();

  await h.add("AMD, PLTR", "growth");
  expect(await h.watchlistOf("AMD")).toEqual(["growth"]);
  expect(h.notices.at(-1)?.body).toBe('Watchlist "Growth": 2 added.');
});

test("one symbol is not a list, and the text says whether its separators are plain", () => {
  expect(pastedSymbolList("NVDA")).toBeNull();
  expect(pastedSymbolList("NVDA,")).toBeNull();
  expect(pastedSymbolList("nvda amd")).toEqual({ symbols: ["nvda", "amd"], repeated: 0, separated: false });
  expect(pastedSymbolList("NVDA\nAMD\r\nNVDA")).toEqual({ symbols: ["NVDA", "AMD"], repeated: 1, separated: true });
});

test("one typed symbol is decided as a symbol of a pasted list is: a match abroad of a US symbol is not added, one listed only abroad is, alone or in a list", async () => {
  const h = await harness();
  const stored = () => [...h.state.tickers.values()].filter((ticker) => ticker.metadata.ticker.startsWith("DFS"));
  const refusal = "DFS was Discover Financial Services until 2025, now Capital One Financial: COF; DFS matched DFS:LSE (DFS Furniture plc), a listing abroad";
  await h.add("DFS");
  expect(h.notices.at(-1)).toMatchObject({ type: "error", body: `${refusal}.\nAdd COF for what it trades as now, or DFS:LSE to keep the match.` });
  expect(h.routes).toEqual([]);
  await h.add("DFS, AMD");
  expect(h.notices.at(-1)?.body).toContain(refusal);
  expect(stored()).toEqual([]);

  // Nothing in the US goes by GARAN: it is added on its listing, saying where, alone and in a list.
  const abroad = "GARAN has no US listing; it trades on BIST, in TRY.";
  await h.add("GARAN");
  expect(h.notices.slice(-2)).toEqual([{ body: 'Added GARAN to "Watchlist".', type: "success" }, { body: abroad, type: "info" }]);
  expect(await h.watchlistOf("GARAN")).toEqual(["watchlist"]);
  const list = await harness();
  await list.add("GARAN, AMD");
  expect(list.notices.at(-1)?.body).toBe(`Watchlist "Watchlist": 2 added.\n${abroad}`);
});

test("a symbol typed or pasted with its vendor's suffix is its venue's listing, one row with the bare symbol's", async () => {
  const h = await harness();
  await h.add("GARAN.IS");
  expect(h.notices.at(-1)).toEqual({ body: 'Added GARAN to "Watchlist".', type: "success" });
  await h.add("GARAN:BIST");
  await h.add("GARAN.IS, AMD");
  expect(h.notices.at(-1)?.body).toBe('Watchlist "Watchlist": 1 added, 1 already in the list.');
  expect([...h.state.tickers.keys()].filter((key) => key.startsWith("GARAN"))).toEqual(["GARAN"]);
  expect(await h.watchlistOf("GARAN")).toEqual(["watchlist"]);
  expect(await h.watchlistOf("GARAN.IS")).toBeNull();
});
