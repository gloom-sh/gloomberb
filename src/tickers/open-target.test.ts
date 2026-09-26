import { expect, test } from "bun:test";
import { JsonTickerRepository } from "../data/json-ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import { AmbiguousTickerError } from "./search";
import { resolveTickerOpenTarget } from "./open-target";
import { createTestTicker } from "../test-support/ticker";

test("opening validated venue links hydrates their exact key without changing another listing's holdings", async () => {
  for (const query of ["VOD:XLON", "VOD.L"]) {
    for (const savedExchange of [null, "NASDAQ", "LSE"]) {
      const tickerRepository = new JsonTickerRepository();
      const saved = savedExchange ? await tickerRepository.createTicker(createTestTicker("VOD", "Vodafone", {
        exchange: savedExchange,
        currency: savedExchange === "LSE" ? "GBP" : "USD",
        portfolios: ["retirement"],
        positions: [{ portfolio: "retirement", shares: 10, avgCost: 20, broker: "manual", currency: "USD" }],
      }).metadata) : null;
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
  const tickerRepository = new JsonTickerRepository();
  const target = await resolveTickerOpenTarget({
    query: "brkb", tickerRepository, tickers: new Map(),
    dataProvider: createTestDataProvider({ search: async () => [{ providerId: "cloud", symbol: "BRK.B", exchange: "NYSE", currency: "USD", name: "Berkshire Hathaway", type: "EQUITY" }] }),
  });
  expect(target?.symbol).toBe("BRK.B");
  expect(await tickerRepository.loadTicker("BRKB")).toBeNull();
});

test("quote-only hydration verifies the returned symbol and listing before preserving a qualified key", async () => {
  for (const query of ["VOD:XLON", "VOD.L"]) {
    for (const [symbol, exchange, valid] of [
      ["VOD", "NASDAQ", false],
      ["BARC", "LSE", false],
      ["VOD", undefined, false],
      ["VOD.L", "NASDAQ", false],
      ["VOD", "LSE", true],
      ["VOD.L", "LSE", true],
    ] as const) {
      const tickerRepository = new JsonTickerRepository();
      const target = await resolveTickerOpenTarget({
        query, tickerRepository, tickers: new Map(),
        dataProvider: createTestDataProvider({ getQuote: async () => ({
          symbol, exchangeName: exchange, price: 1.25, currency: "GBP", lastUpdated: 1, change: 0, changePercent: 0,
        }) }),
      });
      if (!valid) {
        expect(target).toBeNull();
        expect(await tickerRepository.loadAllTickers()).toEqual([]);
      } else {
        expect(target?.ticker.metadata).toMatchObject({ ticker: query, exchange: "LSE", currency: "GBP" });
      }
    }
  }
});


test("ambiguous search cannot fall through to an unqualified quote and create a ticker", async () => {
  const tickerRepository = new JsonTickerRepository();
  let quoteCalls = 0;
  await expect(resolveTickerOpenTarget({ query: "GLD", tickerRepository, tickers: new Map(),
    dataProvider: createTestDataProvider({
      search: async () => ["BYMA", "NYSE"].map((exchange) => ({ providerId: "cloud", symbol: "GLD", name: "SPDR", exchange, type: "ETF" })),
      getQuote: async () => { quoteCalls++; return { symbol: "GLD", currency: "USD", price: 400, lastUpdated: 1, change: 0, changePercent: 0 }; },
    }),
  })).rejects.toBeInstanceOf(AmbiguousTickerError);
  expect(quoteCalls).toBe(1);
  expect(await tickerRepository.loadAllTickers()).toEqual([]);
});
