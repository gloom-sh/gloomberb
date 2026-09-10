import { afterEach, expect, test } from "bun:test";
import { JsonTickerRepository } from "../../../../data/json-ticker-repository";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import { type PluginRegistry, setSharedRegistryForTests } from "../../../registry";
import { validateScreenerResults } from "./results";

afterEach(() => setSharedRegistryForTests(undefined));

function setup() {
  const values = new Map<string, string>();
  const tickerRepository = new JsonTickerRepository({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  setSharedRegistryForTests({ tickerRepository, events: { emit() {} } } as unknown as PluginRegistry);
  return tickerRepository;
}

function result(symbol: string, exchange: string): InstrumentSearchResult {
  return { providerId: "cloud", symbol, exchange, currency: exchange === "LSE" ? "GBP" : "USD", name: symbol, type: "ETF" };
}

test("AI screener preserves dotted share classes and venue aliases instead of stripping their identity", async () => {
  const repository = setup();
  const dataProvider = createTestDataProvider({ search: async () => [result("BRK.B", "NYSE"), result("VWRL", "LSE")] });
  const validated = await validateScreenerResults([
    { symbol: "BRK.B", exchange: "NYSE", reason: "Class B" },
    { symbol: "VWRL.L", exchange: "LSE", reason: "Distributing UK listing" },
  ], new Map(), () => {}, dataProvider);
  expect(validated.results.map((entry) => [entry.symbol, entry.exchange])).toEqual([["BRK.B", "NYSE"], ["VWRL", "LSE"]]);
  expect(validated.warning).toBeNull();
  expect((await repository.loadAllTickers()).map((ticker) => ticker.metadata.ticker).sort()).toEqual(["BRK.B", "VWRL"]);
});

test("AI screener refuses a wrong-exchange ADR and distinguishes saved listings in the same result set", async () => {
  const repository = setup();
  const onlyAdr = createTestDataProvider({ search: async () => [result("VOD", "NASDAQ")] });
  const rejected = await validateScreenerResults([{ symbol: "VOD", exchange: "XLON", reason: "UK income" }], new Map(), () => {}, onlyAdr);
  expect(rejected.results).toEqual([]);
  expect(rejected.warning).toContain("Could not resolve 1: VOD");
  expect(await repository.loadAllTickers()).toEqual([]);

  const bothListings = createTestDataProvider({ search: async () => [result("VOD", "NASDAQ"), result("VOD", "LSE")] });
  const validated = await validateScreenerResults([
    { symbol: "VOD", exchange: "NASDAQ", reason: "ADR" },
    { symbol: "VOD", exchange: "LSE", reason: "UK ordinary" },
  ], new Map(), () => {}, bothListings);
  expect(validated.results.map((entry) => [entry.symbol, entry.exchange])).toEqual([["VOD", "NASDAQ"], ["VOD:XLON", "LSE"]]);

  const saved = await repository.loadTicker("VOD:XLON");
  const reused = await validateScreenerResults([{ symbol: "VOD", exchange: "XLON", reason: "UK income" }],
    new Map([["VOD:XLON", saved!]]), () => {}, createTestDataProvider({ search: async () => { throw new Error("Should use saved listing"); } }));
  expect(reused.results[0]?.symbol).toBe("VOD:XLON");
});

test("an unqualified dual listing cannot silently select the first search result", async () => {
  const repository = setup();
  const provider = createTestDataProvider({ search: async () => [result("ASML", "NASDAQ"), result("ASML", "AMS")] });
  const ambiguous = await validateScreenerResults([{ symbol: "ASML", exchange: "", reason: "Technology" }], new Map(), () => {}, provider);
  expect(ambiguous.results).toEqual([]);
  expect(await repository.loadAllTickers()).toEqual([]);
  const qualified = await validateScreenerResults([{ symbol: "ASML.AS", exchange: "AMS", reason: "EUR listing" }], new Map(), () => {}, provider);
  expect(qualified.results[0]?.exchange).toBe("AMS");
});

test("a failed lookup retains other resolved candidates and identifies incomplete coverage", async () => {
  setup();
  const provider = createTestDataProvider({ search: async (symbol) => {
    if (symbol === "FAIL") throw new Error("upstream unavailable");
    return [result("MSFT", "NASDAQ")];
  } });
  const validated = await validateScreenerResults([
    { symbol: "FAIL", exchange: "NYSE", reason: "Unverified" },
    { symbol: "MSFT", exchange: "NASDAQ", reason: "Candidate" },
  ], new Map(), () => {}, provider);
  expect(validated.results.map((entry) => entry.symbol)).toEqual(["MSFT"]);
  expect(validated.warning).toContain("Lookup failed for 1: FAIL");
});
