import { expect, test } from "bun:test";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { loadEventSources } from "./event-sources";

test("a missing event currency stays blank, and an explicit code still wins the chain", async () => {
  const blank = await loadEventSources(createTestDataProvider({
    getTickerFinancials: async () => createTestFinancials(),
  }), "X");
  expect(blank.currency).toBe("");

  const usd = await loadEventSources(createTestDataProvider({
    getCorporateActions: async () => ({ symbol: "X", currency: "USD", dividends: [], splits: [], earnings: [] }),
    getTickerFinancials: async () => createTestFinancials(),
  }), "X");
  expect(usd.currency).toBe("USD");

  const eur = await loadEventSources(createTestDataProvider({
    getTickerFinancials: async () => createTestFinancials({ quote: createTestQuote({ symbol: "X", currency: "EUR" }) }),
  }), "X");
  expect(eur.currency).toBe("EUR");
});
