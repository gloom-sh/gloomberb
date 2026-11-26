import { expect, test } from "bun:test";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { loadEventSources } from "./event-sources";

test("a known fund does not read the analyst endpoint or mask a failed payout read", async () => {
  let reads = 0;
  const load = (instrumentType: string) => loadEventSources(createTestDataProvider({
    getCorporateActions: async () => { throw new Error("distributions unavailable"); },
    getTickerFinancials: async () => createTestFinancials({ quote: createTestQuote({ instrumentType }) }),
    getAnalystResearch: async () => { reads++; throw new Error("estimates unavailable"); },
  }), "AFK");
  expect(await load("ETF")).toMatchObject({ actionsError: "distributions unavailable", estimatesError: null });
  expect(reads).toBe(0);
  expect(await load("EQUITY")).toMatchObject({ estimatesError: "estimates unavailable" });
  expect(reads).toBe(1);
});

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
