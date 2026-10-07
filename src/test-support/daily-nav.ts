import type { Quote } from "../types/financials";

/** Daily fund observation supplied by the standard quote and financials routes. */
export function createDailyNavQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    symbol: "VFIAX",
    name: "Vanguard 500 Index Fund Admiral Shares",
    instrumentType: "MUTUALFUND",
    priceObservation: "nav",
    priceBasis: "per-unit",
    price: 721.63,
    previousClose: 718.5,
    change: 3.13,
    changePercent: 3.13 / 718.5 * 100,
    currency: "USD",
    changeSessionDate: "2026-10-06",
    lastUpdated: 1791259200000,
    listingExchangeName: "NASDAQ",
    exchangeName: "NMS",
    dataSource: "delayed",
    stale: false,
    sessionConfidence: "unknown",
    ...overrides,
  };
}
