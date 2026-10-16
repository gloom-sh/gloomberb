import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerChanges } from "../types/ticker-changes";
import { createTestDataProvider, createTestFinancials, createTestQuote } from "./data-provider";

/*
 * Symbols whose company moved, as Gloom Cloud answers them, beside ones that
 * did not: HFC's company became DINO, RDS-A's (and RDS-B's) became SHEL. A new
 * company holds META (the fund that was META moved to METV, Meta Platforms
 * renamed into it), and AAPL has no change at all.
 */
export const HFC_HOP = { from: "HFC", to: "DINO", date: "2022-03-15" };
const RDS_HOP = { from: "RDS.A", to: "SHEL", date: "2022-01-31" };
const FB_HOP = { from: "FB", to: "META", date: "2022-06-09" };
export const MOVED_SYMBOL_CHANGES: Record<string, TickerChanges> = {
  HFC: { symbol: "HFC", moved: { symbol: "DINO", name: "HF Sinclair Corp", hops: [HFC_HOP] }, formerly: null, listedName: null, changes: [HFC_HOP] },
  "RDS-A": { symbol: "RDS.A", moved: { symbol: "SHEL", name: "Shell plc", hops: [RDS_HOP] }, formerly: null, listedName: null, changes: [RDS_HOP] },
  META: {
    symbol: "META", moved: null, formerly: [FB_HOP], listedName: "Meta Platforms, Inc.",
    changes: [FB_HOP, { from: "META", to: "METV", date: "2022-01-31" }],
  },
};

const HFC_LAST = Date.parse("2022-03-14T23:00:00.002Z");
const RDS_LAST = Date.parse("2022-01-29T00:00:00.001Z");
// The old lines' quotes stopped in 2022, while their source still states today's session.
export const MOVED_SYMBOL_QUOTES: Record<string, Quote> = {
  HFC: createTestQuote({ symbol: "HFC", price: 36.39, lastUpdated: HFC_LAST, lastTradeTime: HFC_LAST, marketState: "REGULAR", stale: true }),
  "RDS-A": createTestQuote({
    symbol: "RDS-A", name: "Shell Plc Sponsored American Depositary Receipt", price: 51.04, listingExchangeName: "NYSE", exchangeName: "NYSE",
    lastUpdated: RDS_LAST, lastTradeTime: RDS_LAST, marketState: "REGULAR", stale: true,
  }),
  META: createTestQuote({ symbol: "META", name: "Meta Platforms, Inc.", price: 736.72, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR" }),
  AAPL: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", price: 342, listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR" }),
};
// Bars come back for every symbol: another listing's under HFC (a Canadian line), SHEL's under RDS-A.
const CLOSES: Record<string, number> = { HFC: 0.26, "RDS-A": 103.58, META: 736.72, AAPL: 342 };

/**
 * A source that serves quotes, bars, financials and news for HFC, RDS-A,
 * META and AAPL whatever became of them, and their ticker changes from
 * `changes` (Gloom Cloud's answers by default). `overrides` replace any method.
 */
export function createMovedSymbolsProvider(
  changes: DataProvider["getTickerChanges"] = async (symbol) => MOVED_SYMBOL_CHANGES[symbol] ?? null,
  overrides: Partial<DataProvider> = {},
): DataProvider {
  const quoteOf = (symbol: string) => {
    const found = MOVED_SYMBOL_QUOTES[symbol];
    if (!found) throw new Error(`Not a ticker: ${symbol}.`);
    return found;
  };
  const bar = (symbol: string) => ({ date: new Date("2026-10-14"), open: CLOSES[symbol]!, high: CLOSES[symbol]!, low: CLOSES[symbol]!, close: CLOSES[symbol]!, volume: 0 });
  // `ticker` reads news beside the rest through the app's source, which the provider type leaves out.
  return Object.assign(createTestDataProvider({
    getQuote: async (symbol) => quoteOf(symbol),
    getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: quoteOf(target.symbol) })),
    getPriceHistory: async (symbol) => [bar(symbol)],
    getPriceHistoryWithMetadata: async (symbol) => ({ resolution: "1d", points: [bar(symbol)] }),
    getTickerFinancials: async (symbol) => createTestFinancials({ quote: quoteOf(symbol), profile: { sector: "Financial Services" } }),
    getTickerChanges: changes,
    ...overrides,
  }), { getNews: async () => [] });
}
