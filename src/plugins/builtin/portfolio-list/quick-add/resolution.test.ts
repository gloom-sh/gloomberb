import { afterEach, describe, expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../../../../types/instrument";
import type { PluginRegistry } from "../../../registry";
import { setSharedRegistryForTests } from "../../../registry";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { exchangeLabelFromValidation, resolveQuickAddValidation, tickerNameFromValidation } from "./resolution";

const nyse: InstrumentSearchResult = {
  providerId: "test", symbol: "NET", name: "Cloudflare", exchange: "NYSE", currency: "USD", type: "STK",
};
const lse: InstrumentSearchResult = {
  providerId: "test", symbol: "NET", name: "Netcall Plc", exchange: "LSE", currency: "GBP", type: "STK",
};

afterEach(() => {
  setSharedRegistryForTests(undefined);
});

describe("quick-add listing resolution", () => {
  test("a symbol whose default listing is unknown asks which one instead of failing", async () => {
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [lse, nyse],
        getQuote: async () => { throw new Error("quote unavailable"); },
      }),
    } as PluginRegistry);
    const validation = await resolveQuickAddValidation({
      query: "NET",
      collectionId: "watchlist",
      collectionKind: "watchlist",
      tickers: new Map(),
      financials: new Map(),
    });
    expect(validation).toEqual({ status: "choose", query: "NET" });
  });

  test("a qualified listing neither borrows nor duplicates another listing saved under its symbol", async () => {
    setSharedRegistryForTests({
      marketData: createTestDataProvider({
        search: async () => [lse, nyse],
        getQuote: async (_symbol, exchange) => createTestQuote({
          symbol: "NET", listingExchangeName: exchange, currency: exchange === "NYSE" ? "USD" : "GBP",
          price: exchange === "NYSE" ? 200 : 1.26,
        }),
      }),
    } as PluginRegistry);
    const saved = createTestTicker("NET", "Cloudflare", { exchange: "NYSE", currency: "USD", watchlists: ["watchlist"] });
    const validation = await resolveQuickAddValidation({
      query: "NET.LON",
      collectionId: "watchlist",
      collectionKind: "watchlist",
      tickers: new Map([[saved.metadata.ticker, saved]]),
      financials: new Map([["NET", { quote: createTestQuote({ symbol: "NET", price: 200, currency: "USD" }) }]]),
    });
    expect(validation.status).toBe("ready");
    if (validation.status !== "ready") return;
    expect(validation.ticker).toBeNull();
    expect(validation.quote?.price).toBe(1.26);
    expect(tickerNameFromValidation(validation)).toBe("Netcall Plc");
    expect(exchangeLabelFromValidation(validation)).toBe("LSE");
  });
});
