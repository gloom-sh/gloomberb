import type { DataProvider } from "../types/data-provider";
import type { InstrumentSearchResult } from "../types/instrument";
import type { Quote, TickerFinancials } from "../types/financials";

function unused<T>(name: string): Promise<T> {
  return Promise.reject(new Error(`${name} is unused in this test`));
}

export function createTestDataProvider(overrides: Partial<DataProvider> = {}): DataProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    getTickerFinancials: async () => unused<TickerFinancials>("getTickerFinancials"),
    getQuote: async () => unused<Quote>("getQuote"),
    getExchangeRate: async () => 1,
    search: async () => [] satisfies InstrumentSearchResult[],
    getArticleSummary: async () => null,
    getPriceHistory: async () => [],
    ...overrides,
  };
}

export function createTestQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "AAPL",
    price: 100,
    currency: "USD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

/** Financials with no statements or history; pass `quote` and any series the test reads. */
export function createTestFinancials(overrides: Partial<TickerFinancials> = {}): TickerFinancials {
  return {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
    ...overrides,
  };
}

/** A source that answers every quote and financials request, for routers that need a last resort. */
export const fallbackProvider: DataProvider = createTestDataProvider({
  id: "fallback",
  name: "Fallback",
  getTickerFinancials: async () => createTestFinancials(),
  getQuote: async () => createTestQuote(),
});
