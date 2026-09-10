import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { loadSectorRows } from "./client";

const sectors = [
  { name: "Technology", etf: "XLK" },
  { name: "Financials", etf: "XLF" },
];
const quote = (symbol: string): Quote => ({
  symbol, price: 105, change: 5, changePercent: 5, currency: "USD", lastUpdated: Date.parse("2026-09-10T18:00:00Z"), changeSessionDate: "2026-09-10",
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


test("uses one session for live returns and rejects short or outdated histories", async () => {
  const provider = {
    getQuotesBatch: async () => [{ target: { symbol: "XLK" }, quote: quote("XLK") }],
    getQuote: async () => null,
    getPriceHistory: async (symbol: string) => symbol === "XLK"
      ? [{ date: new Date("2026-08-10"), close: 90 }, { date: new Date("2026-09-09"), close: 100 }]
      : [{ date: new Date("2025-09-10"), close: 80 }, { date: new Date("2026-08-10"), close: 90 }, { date: new Date("2026-09-09"), close: 100 }],
  } as unknown as DataProvider;
  const rows = await loadSectorRows(sectors, provider);
  expect(rows[0]?.row?.return1M).toBeCloseTo(16.6666667);
  expect(rows[0]?.row).toMatchObject({ return1Y: null, returnAsOfDate: "2026-09-10", return1MStartDate: "2026-08-10" });
  expect(rows[1]?.row).toMatchObject({ return1M: null, return1Y: null, quoteUnavailable: true });
});

test("requests a boundary buffer when the prior-year date falls on a holiday", async () => {
  let requestedStart: string | null = null;
  const sessionQuote = { ...quote("XLK"), changeSessionDate: "2026-10-12", lastUpdated: Date.parse("2026-10-12T18:00:00Z") };
  const provider = {
    getQuote: async () => sessionQuote,
    getPriceHistory: async () => [{ date: new Date("2025-10-13"), close: 101 }, { date: new Date("2026-10-12"), close: 104 }],
    getDetailedPriceHistory: async (_symbol: string, _exchange: string, start: Date) => {
      requestedStart = start.toISOString().slice(0, 10);
      return [{ date: new Date("2025-10-10"), close: 100 }];
    },
  } as unknown as DataProvider;
  const [result] = await loadSectorRows(sectors.slice(0, 1), provider);
  expect(requestedStart).toBe("2025-10-05");
  expect(result?.row?.return1Y).toBeCloseTo(5);
  expect(result?.row?.return1YStartDate).toBe("2025-10-10");
});


test("one missing baseline bar cannot change a fund's comparison window", async () => {
  const provider = {
    getQuote: async (symbol: string) => quote(symbol),
    getPriceHistory: async (symbol: string) => [
      { date: new Date("2025-09-10"), close: 80 },
      { date: new Date("2026-08-07"), close: 85 },
      ...(symbol === "XLK" ? [{ date: new Date("2026-08-10"), close: 90 }] : []),
      { date: new Date("2026-09-10"), close: 100 },
    ],
  } as unknown as DataProvider;
  const outcomes = await loadSectorRows(sectors, provider);
  expect(outcomes[0]?.row?.return1M).toBeCloseTo(16.6666667);
  expect(outcomes[1]?.row?.return1M).toBeNull();
  expect(outcomes.map(({ row }) => row?.return1Y)).toEqual([31.25, 31.25]);
});
