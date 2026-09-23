import { expect, test } from "bun:test";
import { mergePlainRootTickerResults, mergeTickerSearchResultItems } from "../components/command-bar/routes/ticker-search/results";
import { createTestDataProvider } from "../test-support/data-provider";
import { buildTickerSearchCandidates, rankTickerSearchItems, resolveTickerSearch } from "./search";
import type { InstrumentSearchResult } from "../types/instrument";
import type { TickerRecord } from "../types/ticker";

// Exact ASML catalogue order/fields captured 2026-09-22 from Cloud search.
const asmlResults: InstrumentSearchResult[] = [
  ["ASML", "ASML Holding N.V. NY Registered Shares", "NASDAQ", "Depositary Receipt", "USD"],
  ["ASML", "ASML Holding N.V.", "BYMA", "Depositary Receipt", "ARS"],
  ["ASML", "ASML Holding N.V.", "AMS", "Common Stock", "EUR"],
  ["ASML", "ASML Holding N.V. Depositary Receipt", "TSX", "Depositary Receipt", "CAD"],
  ["ASML", "ASML Holding N.V.", "NEO", "Depositary Receipt", "CAD"],
  ["ASML", "ASML Holding N.V.", "WSE", "Common Stock", "PLN"],
  ["ASML", "ASML Holding N.V.", "VIE", "Common Stock", "EUR"],
  ["ASML", "ASML Holding N.V. NY Registered Shares", "IEX", "Depositary Receipt", "USD"],
  ["ASML", "ASML Holding N.V.", "SWX", "Common Stock", "CHF"],
  ["4ASML", "ASML", "BIT", "Common Stock", "EUR"],
].map(([symbol, name, exchange, type, currency]) => ({
  providerId: "gloomberb-cloud", symbol: symbol!, name: name!, exchange: exchange!,
  primaryExchange: exchange!, type: type!, currency,
}));

test("ASML registered shares retain provider relevance within the five exact-symbol results", () => {
  const original = JSON.stringify(asmlResults);
  const candidates = buildTickerSearchCandidates({ query: "ASML", tickers: new Map(), providerResults: asmlResults });
  const items = candidates.map(row => ({ ...row, action() {} }));
  const visible = mergePlainRootTickerResults("ASML", mergeTickerSearchResultItems("ASML", items, []), []);
  expect(visible.map(row => row.right)).toEqual(["NASDAQ", "BYMA", "AMS", "TSX", "NEO"]);
  expect(candidates[0]?.result).toBe(asmlResults[0]);
  expect(candidates[0]?.detail).toContain("ASML Holding N.V. NY Registered Shares");
  expect(candidates.every(row => row.label === row.symbol)).toBe(true);
  expect(JSON.stringify(asmlResults)).toBe(original);
});

test("issuer descriptor grouping keeps explicit ASML venues independent of a saved Amsterdam listing", async () => {
  const saved: TickerRecord = { metadata: { ticker: "ASML", name: "ASML Holding N.V.", exchange: "AMS", currency: "EUR",
    portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] } };
  const tickers = new Map([["ASML", saved]]);
  const provider = createTestDataProvider({ search: async () => asmlResults,
    getQuote: async () => { throw new Error("Explicit venues must not need default quote disambiguation"); } });
  for (const [query, exchange] of [["ASML:XNAS", "NASDAQ"], ["ASML:XAMS", "AMS"], ["ASML.AS", "AMS"]]) {
    const candidates = buildTickerSearchCandidates({ query: query!, tickers, providerResults: asmlResults });
    expect(candidates[0]?.exchangeLabel).toBe(exchange);
    const resolved = await resolveTickerSearch({ query, activeTicker: null, tickers, dataProvider: provider });
    expect(resolved?.kind === "local" ? resolved.ticker.metadata.exchange : resolved?.result.exchange).toBe(exchange);
  }
  expect(tickers.get("ASML")).toBe(saved);
  expect(saved.metadata.exchange).toBe("AMS");
});

test("only recognized issuance tails group with the issuer; comparator order remains stable", () => {
  for (const [suffix, sameIssuer] of [
    ["NY Registered Shares", true], ["New York Registered Shares", true],
    ["Depositary Receipt", true], ["Depositary Receipts", true],
    ["Class B Shares", false], ["Ordinary Shares", false], ["Daily 2x", false], ["Finance", false],
  ] as const) {
    const candidates = [
      { id: "descriptor", label: "ZZZ", symbol: "ZZZ", detail: `Acme Holdings S.A. ${suffix}`, right: "NASDAQ",
        kind: "search", category: "Other Listings", instrumentClass: "equity" as const, providerRank: 0 },
      { id: "base", label: "YYY", symbol: "YYY", detail: "Acme Holdings SA", right: "NYSE",
        kind: "search", category: "Other Listings", instrumentClass: "equity" as const, providerRank: 2 },
      { id: "different-issuer", label: "XXX", symbol: "XXX", detail: "Acme Holdings International", right: "AMS",
        kind: "search", category: "Other Listings", instrumentClass: "equity" as const, providerRank: 1 },
    ];
    // Name-only matches follow provider order, so only a shared issuer keeps
    // the base listing next to its descriptor ahead of the provider's second.
    const expected = sameIssuer ? ["descriptor", "base", "different-issuer"] : ["descriptor", "different-issuer", "base"];
    const forward = rankTickerSearchItems(candidates, "Acme").map(row => row.id);
    expect(forward).toEqual(expected);
    expect(rankTickerSearchItems([...candidates].reverse(), "Acme").map(row => row.id)).toEqual(forward);
  }
});
