import { expect, test } from "bun:test";
import type { AppTickerRepositoryPort } from "../../../../core/app-service-ports";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import type { TickerRecord } from "../../../../types/ticker";
import { lookUpPositionSymbols } from "./lookup";

test("a preview's lookup saves nothing, and two spellings of one new listing share its record", async () => {
  const saved = createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" });
  const writes: string[] = [];
  const store: AppTickerRepositoryPort = {
    loadTicker: async (symbol) => symbol === "AAPL" ? saved : null,
    loadAllTickers: async () => [saved],
    saveTicker: async (ticker: TickerRecord) => { writes.push(ticker.metadata.ticker); },
    createTicker: async (metadata) => { writes.push(metadata.ticker); return { metadata }; },
    deleteTicker: async (symbol) => { writes.push(`-${symbol}`); },
  };
  const listing = (symbol: string) => ({ providerId: "test", symbol, name: "Berkshire Hathaway Inc.", exchange: "NYSE", currency: "USD", type: "STK" });
  const dataProvider = createTestDataProvider({
    search: async (query) => /^BRK[.-]B$/.test(query) ? [listing("BRK.B")] : [],
    getQuote: async (symbol) => {
      if (!/^BRK[.-]B$/.test(symbol)) throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol: "BRK.B", name: "Berkshire Hathaway Inc.", listingExchangeName: "NYSE", exchangeName: "NYSE" });
    },
  });

  const lookup = await lookUpPositionSymbols(["AAPL", "BRK.B", "BRK-B", "ZZZZQ"], {
    tickers: new Map([["AAPL", saved]]),
    store,
    dataProvider,
  });

  expect(writes).toEqual([]);
  const resolved = (symbol: string) => {
    const resolution = lookup.resolutions.get(symbol);
    return resolution && "ticker" in resolution ? resolution.ticker : resolution?.error;
  };
  expect(resolved("AAPL")).toBe(saved);
  expect((resolved("BRK.B") as TickerRecord).metadata.ticker).toBe("BRK.B");
  expect(resolved("BRK-B")).toBe(resolved("BRK.B"));
  expect(resolved("ZZZZQ")).toBe('No ticker match found for "ZZZZQ".');
  expect([...lookup.unsaved]).toEqual(["BRK.B"]);
});
