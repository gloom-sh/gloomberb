import type { TickerRecord } from "../types/ticker";

export function createTestTicker(
  symbol: string,
  name = symbol,
  overrides: Partial<TickerRecord["metadata"]> = {},
): TickerRecord {
  return {
    metadata: {
      ticker: symbol, exchange: "NASDAQ", currency: "USD", name,
      portfolios: [], watchlists: [], positions: [], custom: {}, tags: [],
      ...overrides,
    },
  };
}
