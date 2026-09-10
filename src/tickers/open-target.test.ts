import { expect, test } from "bun:test";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import { resolveTickerOpenTarget } from "./open-target";

function repository() {
  const values = new Map<string, string>();
  return new JsonTickerRepository({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
}

test("opening validated venue links hydrates their exact key without changing another listing's holdings", async () => {
  for (const query of ["VOD:XLON", "VOD.L"]) {
    for (const savedExchange of [null, "NASDAQ", "LSE"]) {
      const tickerRepository = repository();
      const saved = savedExchange ? await tickerRepository.createTicker({
        ticker: "VOD", exchange: savedExchange, currency: savedExchange === "LSE" ? "GBP" : "USD", name: "Vodafone",
        portfolios: ["retirement"], watchlists: [], positions: [{ portfolio: "retirement", shares: 10, avgCost: 20, broker: "manual", currency: "USD" }], custom: {}, tags: [],
      }) : null;
      const before = await tickerRepository.loadTicker("VOD");
      const target = await resolveTickerOpenTarget({
        query, tickerRepository, tickers: new Map(saved ? [["VOD", saved]] : []),
        dataProvider: createTestDataProvider({ search: async () => [{ providerId: "cloud", symbol: "VOD", exchange: "LSE", currency: "GBp", name: "Vodafone Group", type: "EQUITY" }] }),
      });
      expect(target?.symbol).toBe(query);
      expect(target?.ticker.metadata).toMatchObject({ ticker: query, exchange: "LSE", positions: [], portfolios: [] });
      expect(await tickerRepository.loadTicker(query)).not.toBeNull();
      expect(await tickerRepository.loadTicker("VOD")).toEqual(before);
    }
  }
});

test("opening an ordinary query keeps the provider ticker instead of persisting search text", async () => {
  const tickerRepository = repository();
  const target = await resolveTickerOpenTarget({
    query: "brkb", tickerRepository, tickers: new Map(),
    dataProvider: createTestDataProvider({ search: async () => [{ providerId: "cloud", symbol: "BRK.B", exchange: "NYSE", currency: "USD", name: "Berkshire Hathaway", type: "EQUITY" }] }),
  });
  expect(target?.symbol).toBe("BRK.B");
  expect(await tickerRepository.loadTicker("BRKB")).toBeNull();
});

test("quote-only hydration rejects a conflicting reported listing exchange", async () => {
  for (const query of ["VOD:XLON", "VOD.L"]) {
    for (const exchange of ["NASDAQ", "LSE"]) {
      const tickerRepository = repository();
      const target = await resolveTickerOpenTarget({
        query, tickerRepository, tickers: new Map(),
        dataProvider: createTestDataProvider({ getQuote: async () => ({
          symbol: "VOD", exchangeName: exchange, price: 1.25, currency: "GBP", lastUpdated: 1, change: 0, changePercent: 0,
        }) }),
      });
      if (exchange === "NASDAQ") {
        expect(target).toBeNull();
        expect(await tickerRepository.loadAllTickers()).toEqual([]);
      } else {
        expect(target?.ticker.metadata).toMatchObject({ ticker: query, exchange: "LSE", currency: "GBP" });
      }
    }
  }
});
