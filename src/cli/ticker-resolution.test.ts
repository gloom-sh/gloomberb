import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../data/app-persistence";
import { TickerRepository } from "../data/ticker-repository";
import { createTestDataProvider } from "../test-support/data-provider";
import type { Quote } from "../types/financials";
import { resolveTickerForCli } from "./ticker-resolution";

const persistences: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
});

test("names a new listing from its own quote, not a catalogue row filed under another company", async () => {
  const quote = { symbol: "BA.L", price: 20.23, currency: "GBP", change: 0, changePercent: 0, lastUpdated: 1 };
  for (const [served, name] of [
    [{ ...quote, name: "BAE Systems plc", listingExchangeName: "LSE" }, "BAE Systems plc"],
    // Boeing's bare line, cached without a listing, must not rename the record.
    [{ ...quote, symbol: "BA", name: "Boeing Co/The", currency: "USD" }, "Boeing Co/The"],
  ] as const) {
    const persistence = new AppPersistence(":memory:");
    persistences.push(persistence);
    const store = new TickerRepository(persistence.tickers);
    const dataProvider = createTestDataProvider({
      search: async () => [
        { providerId: "test", symbol: "BA", name: "Boeing Co/The", exchange: "NYSE", currency: "USD", type: "Common Stock" },
        { providerId: "test", symbol: "BA", name: "Boeing Co/The", exchange: "LSE", currency: "GBp", type: "Common Stock" },
      ],
      getQuote: async (symbol, exchange) => {
        expect([symbol, exchange]).toEqual(["BA", "LSE"]);
        return served as Quote;
      },
    });

    const ticker = await resolveTickerForCli("BA:LSE", store, dataProvider);
    expect(ticker.metadata).toMatchObject({ exchange: "LSE", name });
    expect((await store.loadTicker(ticker.metadata.ticker))?.metadata.name).toBe(name);
  }
});
