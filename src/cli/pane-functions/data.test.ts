import { describe, expect, test } from "bun:test";
import { clipPriceHistoryToRange, createFallbackTicker } from "./data";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import type { QuoteMetadata } from "../../types/financials";
import { mayBeUsEquityTicker } from "../../utils/sec";
import type { MarketContext } from "../types";

describe("clipPriceHistoryToRange", () => {
  test("anchors the requested window to the newest provider observation", () => {
    const points = [
      { date: new Date("2025-07-16T00:00:00Z"), close: 100 },
      { date: new Date("2025-07-17T00:00:00Z"), close: 101 },
      { date: new Date("2026-07-17T00:00:00Z"), close: 120 },
    ];

    expect(clipPriceHistoryToRange(points, "1Y").map(({ date }) => date.toISOString().slice(0, 10))).toEqual([
      "2025-07-17",
      "2026-07-17",
    ]);
  });
});

describe("createFallbackTicker", () => {
  const nyse = { symbol: "CRBG", listingExchangeName: "NYSE", currency: "USD", instrumentType: "EQUITY", source: {} };
  function context(metadata: () => Promise<QuoteMetadata | null>) {
    const asked: string[] = [];
    return {
      asked,
      context: { config: { baseCurrency: "EUR" }, dataProvider: { getQuoteMetadata: async (symbol: string) => {
        asked.push(symbol);
        return metadata();
      } } } as unknown as MarketContext,
    };
  }

  // A thin US listing after the close has no usable quote; the shot must still
  // know it is a US listing, and must not guess the base currency for it.
  test.each([
    ["the quote", "CRBG", createTestFinancials({ quote: createTestQuote({ symbol: "CRBG", listingExchangeName: "NYSE" }) }), "NYSE", "USD", false],
    ["the metadata kept when the quote was dropped", "CRBG", createTestFinancials({ quoteMetadata: nyse }), "NYSE", "USD", false],
    ["the source, asked once nothing else knows", "CRBG", createTestFinancials(), "NYSE", "USD", true],
    ["a listing key", "SAN:EPA", createTestFinancials(), "EPA", "", false],
  ] as const)("reads the listing from %s", async (_what, symbol, financials, exchange, currency, asks) => {
    const { context: market, asked } = context(async () => nyse);
    const ticker = await createFallbackTicker(symbol, financials, market);
    expect(ticker.metadata).toMatchObject({ exchange, currency });
    expect(asked.length > 0).toBe(asks);
  });

  test("leaves an unknown listing empty, which the SEC panes read as a US ticker", async () => {
    const { context: market } = context(async () => { throw new Error("unavailable"); });
    const ticker = await createFallbackTicker("CRBG", createTestFinancials(), market);
    expect(ticker.metadata).toMatchObject({ exchange: "", currency: "" });
    expect(mayBeUsEquityTicker(ticker)).toBe(true);
  });
});
