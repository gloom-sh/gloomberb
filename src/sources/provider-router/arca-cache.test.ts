import { expect, test } from "bun:test";
import { AssetDataRouter } from "./index";
import { AppPersistence } from "../../data/app-persistence";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { Quote, TickerFinancials } from "../../types/financials";
import { activeUsExtendedHoursSession } from "../../market-data/market/freshness";

function financials(exchange: string, price: number, instrumentType: string): TickerFinancials {
  const quote: Quote = { symbol: "TIP", listingExchangeName: exchange, exchangeName: exchange,
    currency: "USD", price, change: 0, changePercent: 0, lastUpdated: Date.now(),
    marketState: activeUsExtendedHoursSession(Date.now()) ?? "REGULAR", preMarketPrice: price, postMarketPrice: price, instrumentType };
  return { quote, annualStatements: instrumentType === "ETF" ? [] : [{ date: "2025-12-31", currency: "USD", totalRevenue: 666 }],
    quarterlyStatements: [], priceHistory: [] };
}

for (const mode of ["single", "batch"] as const) test(`${mode} rejects wrong-listing research before unusable quotes lose their identity`, async () => {
  for (const kind of ["quote", "metadata", "contribution", "malformed-metadata"] as const) {
    const store = new AppPersistence(":memory:");
    const old = financials("AMEX", 666, "EQUITY");
    const invalidQuote = { ...old.quote!, price: NaN, preMarketPrice: undefined, postMarketPrice: undefined };
    const wrong = { ...old, quote: kind === "quote" ? invalidQuote : undefined,
      ...(kind === "contribution" ? { quoteContributions: { fixture: { ...invalidQuote, providerId: "fixture" } } } : {}),
      ...(kind.includes("metadata") ? { quoteMetadata: { symbol: kind === "malformed-metadata" ? 42 : "TIP", listingExchangeName: "AMEX" } } : {}) } as TickerFinancials;
    const good = { ...financials("ARCA", 105, "ETF"), quote: { ...financials("ARCA", 105, "ETF").quote!, symbol: "SPY" } };
    const provider = createTestDataProvider({
      getTickerFinancials: async (symbol) => symbol === "TIP" ? wrong : good,
      getTickerFinancialsBatch: async (targets) => targets.map((target) => ({ target, financials: target.symbol === "TIP" ? wrong : good })),
      getQuote: async () => { throw new Error("No independent quote"); },
    });
    try {
      const router = new AssetDataRouter(provider, [], store.resources);
      if (mode === "single") await expect(router.getTickerFinancials("TIP", "ARCA")).rejects.toThrow();
      else {
        const result = await router.getTickerFinancialsBatch([{ symbol: "TIP", exchange: "ARCA" }, { symbol: "SPY", exchange: "ARCA" }]);
        expect(result.find((row) => row.target.symbol === "TIP")?.financials?.annualStatements[0]?.totalRevenue).not.toBe(666);
        expect(result.find((row) => row.target.symbol === "SPY")?.financials?.quote?.symbol).toBe("SPY");
      }
      expect(router.getCachedFinancialsForTargets([{ symbol: "TIP", exchange: "ARCA" }]).get("TIP")?.annualStatements[0]?.totalRevenue).not.toBe(666);
    } finally { store.close(); }
  }
});

test("same-listing research remains usable when only its quote is stale", async () => {
  const store = new AppPersistence(":memory:");
  const value = financials("ARCA", 105, "EQUITY");
  value.quote = { ...value.quote!, stale: true, lastUpdated: 1 };
  const provider = createTestDataProvider({ getTickerFinancials: async () => value, getQuote: async () => { throw new Error("Quote unavailable"); } });
  try {
    const result = await new AssetDataRouter(provider, [], store.resources).getTickerFinancials("TIP", "ARCA");
    expect(result.quote).toBeUndefined();
    expect(result.annualStatements[0]?.totalRevenue).toBe(666);
  } finally { store.close(); }
});
