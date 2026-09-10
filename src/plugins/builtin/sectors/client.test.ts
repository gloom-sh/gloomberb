import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { loadSectorRows } from "./client";

const sectors = [
  { name: "Technology", etf: "XLK" },
  { name: "Financials", etf: "XLF" },
];
const quote = (symbol: string): Quote => ({
  symbol, price: 105, change: 5, changePercent: 5, currency: "USD", lastUpdated: 1,
});
const history = [
  { date: "2025-09-10", close: 80 },
  { date: "2026-08-10", close: 90 },
  { date: "2026-09-10", close: 100 },
] as PricePoint[];

describe("sector quote recovery", () => {
  test("retries missing batch items without refetching successful quotes", async () => {
    const retried: string[] = [];
    const provider = {
      getQuotesBatch: async () => [{ target: { symbol: "XLK", exchange: "" }, quote: quote("XLK") }],
      getQuote: async (symbol: string) => { retried.push(symbol); return quote(symbol); },
      getPriceHistory: async () => history,
    } as unknown as DataProvider;
    const rows = await loadSectorRows(sectors, provider);
    expect(retried).toEqual(["XLF"]);
    expect(rows.map(({ row }) => [row?.price, row?.changePercent, row?.quoteUnavailable]))
      .toEqual([[105, 5, false], [105, 5, false]]);
  });

  test("keeps historical returns while leaving unavailable current quotes blank", async () => {
    const provider = {
      getQuotesBatch: async () => { throw new Error("batch unavailable"); },
      getQuote: async () => { throw new Error("quote unavailable"); },
      getPriceHistory: async () => history,
    } as unknown as DataProvider;
    const [result] = await loadSectorRows(sectors.slice(0, 1), provider);
    expect(result?.row).toMatchObject({ price: null, changePercent: null, quoteUnavailable: true });
    expect(result?.row?.return1Y).toBeCloseTo(25);
    expect(result?.row?.return1M).toBeCloseTo(11.111111);
  });
});
