import { useRegularMarketSession } from "../../test-support/market-session";
import { describe, expect, test } from "bun:test";
import { AppPersistence } from "../../data/app-persistence";
import { createTestDataProvider } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import { AssetDataRouter } from "./index";
import { isProviderQuoteUsableForCurrentSession } from "./financials";
import { createTestQuote } from "../../test-support/data-provider";

useRegularMarketSession();

const quote = (symbol: string, overrides: Partial<Quote> = {}) => createTestQuote({ symbol, marketState: "CLOSED", ...overrides });

describe("provider quote identity and price domain", () => {
  test("rejects wrong symbols or known listings without rejecting exact provider listing aliases", () => {
    expect(isProviderQuoteUsableForCurrentSession(quote("NQ=F"), "", "ES=F")).toBe(false);
    expect(isProviderQuoteUsableForCurrentSession(quote("ABC", { listingExchangeName: "LSE" }), "NYSE", "ABC")).toBe(false);
    expect(isProviderQuoteUsableForCurrentSession(quote("2330.TW", { listingExchangeName: "TAI" }), "TWSE", "2330")).toBe(true);
    expect(isProviderQuoteUsableForCurrentSession(quote("AAPL"), "NASDAQ", "AAPL")).toBe(true);
  });

  test("malformed source identity rejects a row before metadata parsing", async () => {
    for (const invalid of [{ symbol: undefined }, { symbol: null }, { symbol: 42 }, { symbol: " " },
      { listingExchangeName: 42 }, { exchangeName: {} }, { instrumentType: [] }]) {
      const malformed = { ...quote("ES=F"), ...invalid } as unknown as Quote;
      expect(isProviderQuoteUsableForCurrentSession(malformed, "", "ES=F")).toBe(false);
      const bad = createTestDataProvider({ id: "malformed", priority: 1,
        getQuote: async () => malformed,
        getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: malformed })),
      });
      const good = createTestDataProvider({ id: "good", priority: 2, getQuote: async (symbol) => quote(symbol, { price: 5000 }) });
      const router = new AssetDataRouter(good, [bad]);
      expect((await router.getQuotesBatch([{ symbol: "ES=F" }]))[0]?.quote?.price).toBe(5000);
    }
  });

  test("negative and zero prices need explicit futures metadata and a usable observation", () => {
    for (const price of [-37.63, 0]) {
      for (const instrumentType of ["FUT", "FUTURE", "FUTURES"]) {
        const value = quote("CL=F", { price, instrumentType });
        expect(isProviderQuoteUsableForCurrentSession(value, "", "CL=F")).toBe(true);
        expect(isProviderQuoteUsableForCurrentSession({ ...value, stale: true })).toBe(false);
        expect(isProviderQuoteUsableForCurrentSession({ ...value, lastUpdated: Infinity })).toBe(false);
      }
      for (const instrumentType of [undefined, "EQUITY", "OPTION", "ETF"]) {
        expect(isProviderQuoteUsableForCurrentSession(quote("CL=F", { price, instrumentType }))).toBe(false);
      }
    }
    for (const price of [NaN, Infinity, -Infinity]) {
      expect(isProviderQuoteUsableForCurrentSession(quote("CL=F", { price, instrumentType: "FUTURE" }))).toBe(false);
    }
  });

  test("single, batch and cached routes fall through mismatched quotes to the matching source", async () => {
    const persistence = new AppPersistence(":memory:");
    const preferred = createTestDataProvider({ id: "wrong-contract", priority: 1,
      getQuote: async () => quote("NQ=F", { price: 43210 }),
      getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: quote("NQ=F", { price: 43210 }) })),
    });
    const fallback = createTestDataProvider({ id: "matching-contract", priority: 2,
      getQuote: async (symbol) => quote(symbol, { price: 5000 }),
    });
    const router = new AssetDataRouter(fallback, [preferred], persistence.resources);
    try {
      const cacheKey = { namespace: "market", kind: "quote", entityKey: "ES=F", variantKey: "", sourceKey: "provider:wrong-contract" };
      const corruptCache = () => persistence.resources.set(cacheKey, quote("NQ=F", { price: 43210 }), { cachePolicy: { staleMs: 60_000, expireMs: 60_000 } });
      corruptCache();
      const noFallback = new AssetDataRouter(preferred, [], persistence.resources);
      await expect(noFallback.getQuote("ES=F")).rejects.toThrow("No quote provider");
      expect((await noFallback.getQuotesBatch([{ symbol: "ES=F" }]))[0]?.quote).toBeNull();
      expect((await router.getQuote("ES=F")).symbol).toBe("ES=F");
      corruptCache();
      expect((await router.getQuotesBatch([{ symbol: "ES=F" }]))[0]?.quote?.price).toBe(5000);
      expect((await router.getQuotesBatch([{ symbol: "ES=F" }], { forceRefresh: true }))[0]?.quote?.symbol).toBe("ES=F");
    } finally { persistence.close(); }
  });

  test("provider streams reject contract substitution and keep valid signed futures prices", () => {
    const seen: Quote[] = [];
    const provider = createTestDataProvider({ subscribeQuotes(targets, onQuote) {
      const target = targets[0]!;
      onQuote(target, quote("OTHER", { price: 999 }));
      onQuote(target, quote(target.symbol, { price: -37.63, instrumentType: "FUTURE" }));
      onQuote(target, quote(target.symbol, { price: 0, instrumentType: "FUTURE" }));
      onQuote(target, quote(target.symbol, { price: NaN, instrumentType: "FUTURE" }));
      return () => {};
    } });
    const unsubscribe = new AssetDataRouter(provider).subscribeQuotes([{ symbol: "CL=F" }], (_target, value) => seen.push(value));
    expect(seen.map(({ symbol, price }) => ({ symbol, price }))).toEqual([{ symbol: "CL=F", price: -37.63 }, { symbol: "CL=F", price: 0 }]);
    unsubscribe();
  });
});
