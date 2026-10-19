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
  // Only DFS Furniture, in London, lists as DFS now.
  DFS: [{ name: "DFS Furniture plc", exchange: "LSE" }],
  // Two companies, and no quote of the bare code settles which.
  "2222": [{ name: "Kotobuki Spirits Co., Ltd.", exchange: "JPX" }, { name: "Saudi Arabian Oil Co.", exchange: "TADAWUL" }],
};

const dataProvider = createTestDataProvider({
  search: async (query) => {
    // Searching the words of a name finds that company.
    const symbol = query.toUpperCase();
    if (symbol === "PALO ALTO") return [{ providerId: "test", symbol: "PANW", name: "Palo Alto Networks, Inc.", exchange: "NASDAQ", currency: "USD", type: "Common Stock" }] satisfies InstrumentSearchResult[];
    return (LISTINGS[symbol] ?? []).map((listing) => ({ providerId: "test", symbol, currency: "USD", type: "Common Stock", ...listing }));
  },
  getQuote: async (symbol, exchange) => {
    const listing = LISTINGS[symbol]?.length === 1 ? LISTINGS[symbol]![0] : LISTINGS[symbol]?.find((entry) => entry.exchange === exchange);
    if (!listing) throw new Error(`Not a ticker: ${symbol}.`);
    return createTestQuote({ symbol, name: listing.name, listingExchangeName: listing.exchange });
  },
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

test("one typed symbol is decided as a symbol of a pasted list is: a match abroad is not added, alone or in a list", async () => {
  const h = await harness();
  const stored = () => [...h.state.tickers.values()].filter((ticker) => ticker.metadata.ticker.startsWith("DFS"));
  await h.add("DFS");
  expect(h.notices.at(-1)).toMatchObject({ type: "error", body: "DFS matched DFS:LSE (DFS Furniture plc), a listing abroad.\nAdd DFS:LSE to keep the match." });
  expect(h.routes).toEqual([]);
  await h.add("DFS, AMD");
  expect(h.notices.at(-1)?.body).toContain("DFS matched DFS:LSE (DFS Furniture plc), a listing abroad");
  expect(stored()).toEqual([]);
});
