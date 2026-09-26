import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { appReducer, createInitialState } from "../state/app/context";
import { createDefaultConfig, createPaneInstance, TICKER_RESEARCH_PANE_ID } from "../types/config";
import { useCommandBarPaneActions } from "../components/command-bar/pane-actions";
import { useCommandBarTickerSearchActions } from "../components/command-bar/routes/ticker-search/actions";
import { mergePlainRootTickerResults, mergeTickerSearchResultItems } from "../components/command-bar/routes/ticker-search/results";
import { createTestDataProvider } from "../test-support/data-provider";
import { AmbiguousTickerError, buildTickerSearchCandidates, resolveTickerSearch, upsertTickerFromSearchResult } from "./search";
import type { InstrumentSearchResult } from "../types/instrument";
import type { PluginRegistry } from "../plugins/registry";
import type { TickerRecord } from "../types/ticker";
import { createTestTicker } from "../test-support/ticker";

// Exact catalogue order and fields from /market/search?q=SHOP&limit=10,
// captured 2026-09-22. A restored SHOP:XNAS row used to hide the first listing.
const shopResults: InstrumentSearchResult[] = [
  ["SHOP", "Shopify Inc.", "NASDAQ", "Common Stock", "USD"],
  ["SHOP", "Shopify Inc.", "TSX", "Common Stock", "CAD"],
  ["SHOP", "Shopify Inc. Class A CEDEAR", "BYMA", "Depositary Receipt", "ARS"],
  ["SHOP", "Shopify Inc.", "NEO", "Common Stock", "CAD"],
  ["SHOP", "Redcare Pharmacy N.V.", "VIE", "Common Stock", "EUR"],
  ["SHOP", "Shopify Inc.", "IEX", "Common Stock", "USD"],
  ["SHOP06", "Shop Apotheke Europe N.V. American Depositary Receipt", "SET", "Depositary Receipt", "THB"],
  ["SHOPC", "Shopify Inc. Class A CEDEAR", "BYMA", "Depositary Receipt", "USD"],
  ["SHOPD", "Shopify Inc. Class A CEDEAR", "BYMA", "Depositary Receipt", "USD"],
  ["SHOPH", "Sunstone Hotel Investors Inc", "IEX", "Preferred Stock", "USD"],
].map(([symbol, name, exchange, type, currency]) => ({
  providerId: "gloomberb-cloud", symbol: symbol!, name: name!, exchange: exchange!,
  primaryExchange: exchange!, type: type!, currency,
}));

function savedTicker(symbol: string, exchange: string, assetCategory = "STK"): TickerRecord {
  return createTestTicker(symbol, "Saved issuer", { exchange, assetCategory });
}

test("restored qualified Shopify stays in the five root results and retargets the focused research pane", async () => {
  const storage = new Map<string, string>();
  const adapter = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  await upsertTickerFromSearchResult(new JsonTickerRepository(adapter), shopResults[0]!, { tickerSymbol: "SHOP:XNAS" });
  const repo = new JsonTickerRepository(adapter);
  const saved = (await repo.loadTicker("SHOP:XNAS"))!;
  const initial = createInitialState(createDefaultConfig(":memory:"));
  const main = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "research:main", binding: { kind: "fixed", symbol: "BTC-USD:CCC" } });
  const existing = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "research:shop", binding: { kind: "fixed", symbol: "SHOP:XNAS" } });
  initial.config.layout.instances = [main, existing];
  initial.tickers = new Map([[saved.metadata.ticker, saved]]);
  initial.focusedPaneId = main.instanceId;
  const stateRef = { current: initial };
  let search!: ReturnType<typeof useCommandBarTickerSearchActions>;
  const registry = { events: { emit() {} }, pinTicker() { throw new Error("The focused research pane should be retargeted"); } } as unknown as PluginRegistry;
  function Harness() {
    const dispatch = (action: Parameters<typeof appReducer>[1]) => { stateRef.current = appReducer(stateRef.current, action); };
    const pane = useCommandBarPaneActions({ dispatch, pluginRegistry: registry, stateRef });
    search = useCommandBarTickerSearchActions({ closeAll() {}, dispatch, focusTicker: pane.focusTicker,
      pluginRegistry: registry, tickerRepository: repo, tickers: initial.tickers });
    return null;
  }
  const rendered = await testRender(<Harness />, { width: 80, height: 12 });
  try {
    await act(async () => { await rendered.renderOnce(); });
    const candidates = buildTickerSearchCandidates({ query: "SHOP", tickers: initial.tickers, providerResults: shopResults });
    const items = search.buildTickerSearchResultItems(candidates, "SHOP");
    const rootAction = { id: "root-action", label: "Open research", detail: "", category: "Panes", kind: "action" as const, action() {} };
    const visible = mergePlainRootTickerResults("SHOP", mergeTickerSearchResultItems("SHOP", items, []), [rootAction]);
    expect(visible.filter(row => row.kind === "ticker" || row.kind === "search").map(row => row.right))
      .toEqual(["NASDAQ", "TSX", "NEO", "IEX", "BYMA"]);
    expect(visible[0]).toMatchObject({ id: "goto:SHOP:XNAS", label: "SHOP:XNAS", category: "Exact Match", kind: "ticker" });
    expect(candidates.filter(row => row.exchangeLabel === "NASDAQ")).toHaveLength(1);
    expect(candidates[0]?.ticker).toBe(saved);
    expect(candidates[0]?.symbol).toBe("SHOP:XNAS");
    await act(async () => { await visible[0]!.action(); });
    expect(stateRef.current.config.layout.instances.find(pane => pane.instanceId === main.instanceId)?.binding)
      .toMatchObject({ kind: "fixed", symbol: "SHOP:XNAS" });
    expect(stateRef.current.config.layout.instances.find(pane => pane.instanceId === existing.instanceId)).toEqual(existing);
    expect(stateRef.current.focusedPaneId).toBe(main.instanceId);
    for (const [query, exchange] of [["SHOP:XTSE", "TSX"], ["SHOP.TO", "TSX"], ["SHOP:XNAS", "NASDAQ"]]) {
      const rows = buildTickerSearchCandidates({ query: query!, tickers: initial.tickers, providerResults: shopResults });
      expect(rows[0]?.exchangeLabel).toBe(exchange);
      const results = search.buildTickerSearchResultItems(rows, query!);
      expect(mergePlainRootTickerResults(query!, results, [rootAction])[0]?.right).toBe(exchange);
    }
  } finally {
    await act(async () => { rendered.renderer.destroy(); });
  }
});

test("ranking a qualified listing does not make an ambiguous bare symbol resolve locally", async () => {
  const saved = savedTicker("SHOP:XNAS", "NASDAQ");
  const tickers = new Map([[saved.metadata.ticker, saved]]);
  let quoteCalls = 0;
  await expect(resolveTickerSearch({ query: "SHOP", activeTicker: null, tickers,
    dataProvider: createTestDataProvider({ search: async () => shopResults, getQuote: async () => { quoteCalls++; return null; } }),
  })).rejects.toBeInstanceOf(AmbiguousTickerError);
  expect(quoteCalls).toBeGreaterThan(0);
});

test("qualified saved ranking keeps literal crypto and share-class punctuation", () => {
  for (const [symbol, exchange, type, lookalike] of [
    ["BTC-USD", "CCC", "CRYPTOCURRENCY", "BTCUSD"],
    ["SHIB/USD", "COINBASE PRO", "Digital Currency", "SHIB-USD"],
    ["BRK.B", "NYSE", "STK", "BRKB"],
  ]) {
    const saved = savedTicker(`${symbol}:${exchange}`, exchange!, type);
    const tickers = new Map([[saved.metadata.ticker, saved]]);
    const providerResults: InstrumentSearchResult[] = [
      { providerId: "fixture", symbol: lookalike!, exchange: "NASDAQ", name: "Lookalike", type: "STK" },
      { providerId: "fixture", symbol: symbol!, exchange: exchange!, name: "Saved issuer", type: type! },
    ];
    const exact = buildTickerSearchCandidates({ query: symbol!, tickers, providerResults });
    expect(exact[0]?.ticker).toBe(saved);
    expect(exact.filter(row => row.exchangeLabel === exchange)).toHaveLength(1);
    const other = buildTickerSearchCandidates({ query: lookalike!, tickers, providerResults });
    expect(other[0]?.symbol).toBe(lookalike);
    const rootRows = other.map(row => ({ id: row.id, label: row.label, detail: row.detail, category: row.category,
      kind: row.kind, right: row.exchangeLabel, instrumentType: row.instrumentType, action() {} }));
    expect(mergePlainRootTickerResults(lookalike!, rootRows, [])[0]?.label).toBe(lookalike);
  }
});
