import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { loadSectorRows } from "./client";
import { projectSectorRows } from "./headless";

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

test("before the open a pre-market print ranks on the last completed session", async () => {
  // XLK printed pre-market on 09-11; XLF has not traded since the 09-10 close.
  const provider = {
    getQuote: async (symbol: string) => symbol === "XLK"
      ? { ...quote(symbol), price: 102, changePercent: 2, previousClose: 100, marketState: "PRE", changeSessionDate: "2026-09-11" }
      : { ...quote(symbol), marketState: "PRE" },
    getPriceHistory: async () => [...history.slice(0, 2), { date: "2026-09-09", close: 96 }, history[2]!],
  } as unknown as DataProvider;
  const rows = await loadSectorRows(sectors, provider);
  expect(rows[0]?.row).toMatchObject({ price: 100, quoteSessionDate: "2026-09-10", returnAsOfDate: "2026-09-10", quoteIssue: null });
  expect(rows[0]?.row?.changePercent).toBeCloseTo(4.1666667);
  expect(rows[1]?.row).toMatchObject({ price: 105, changePercent: 5, quoteIssue: null });
  // A history that has not reached the previous close cannot stand in for it.
  const lagging = { ...provider, getPriceHistory: async () => history.slice(0, 2) } as unknown as DataProvider;
  expect((await loadSectorRows(sectors, lagging))[0]?.row).toMatchObject({ lastReportedPrice: 102, quoteSessionDate: "2026-09-11" });
});

test("a prior-session quote cannot lead the current sector ranking", async () => {
  const provider = {
    getQuote: async (symbol: string) => symbol === "XLK" ? quote(symbol) : {
      ...quote(symbol), price: 117, changePercent: 17, changeSessionDate: "2026-09-09",
    },
    getPriceHistory: async () => history,
  } as unknown as DataProvider;
  const rows = projectSectorRows(sectors, await loadSectorRows(sectors, provider));
  expect(rows.map((row) => row.etf)).toEqual(["XLK", "XLF"]);
  expect(rows[1]).toMatchObject({ price: null, changePercent: null, lastReportedPrice: 117,
    quoteSessionDate: "2026-09-09", quoteUnavailable: true, returnAsOfDate: "2026-09-10" });
  expect(rows[1]?.quoteIssue).toContain("shared session is 2026-09-10");
  expect(rows[1]?.return1M).toBeCloseTo(11.111111);
  expect(rows[1]?.return1Y).toBe(25);
});

test.each([
  { stale: true },
  { changeSessionDate: "2026-02-30" },
  { changeSessionDate: undefined, lastUpdated: NaN },
])("withholds unverifiable session prices even when all quotes share the defect: %j", async (override) => {
  const provider = {
    getQuote: async (symbol: string) => ({ ...quote(symbol), ...override }),
    getPriceHistory: async () => history,
  } as unknown as DataProvider;
  const rows = await loadSectorRows(sectors, provider);
  for (const { row } of rows) {
    expect(row).toMatchObject({ price: null, changePercent: null, quoteUnavailable: true, return1Y: 25 });
    expect(row?.quoteIssue).toBeTruthy();
  }
});

test("missing session change stays unavailable while a reported zero is valid", async () => {
  const provider = {
    getQuote: async (symbol: string) => ({ ...quote(symbol), changePercent: symbol === "XLK" ? NaN : 0 }),
    getPriceHistory: async () => history,
  } as unknown as DataProvider;
  const rows = projectSectorRows(sectors, await loadSectorRows(sectors, provider));
  expect(rows.map((row) => row.etf)).toEqual(["XLF", "XLK"]);
  expect(rows[0]).toMatchObject({ changePercent: 0, quoteIssue: null });
  expect(rows[1]).toMatchObject({ price: 105, changePercent: null, quoteIssue: "1D change unavailable" });
});

test("a corrected boundary response replaces the cached contradiction without mutating it", async () => {
  const bad = { ...history[0]!, open: 80, high: 79, low: 78 };
  const original = { ...bad };
  let corrected = false;
  const provider = {
    getQuote: async (symbol: string) => quote(symbol),
    getPriceHistory: async () => [bad, ...history.slice(1)],
    getDetailedPriceHistory: async () => [{ ...bad, ...(corrected ? { high: 81 } : {}) }],
  } as unknown as DataProvider;
  const [first] = await loadSectorRows(sectors.slice(0, 1), provider);
  expect(first?.row?.return1Y).toBeNull();
  expect(first?.row?.return1M).toBeCloseTo(16.6666667);
  const diagnostic = first?.row?.returnIntegrity?.["1Y"];
  expect(diagnostic?.sourcePoints[0]).toMatchObject({ close: 80, high: 79, low: 78 });
  corrected = true;
  const [next] = await loadSectorRows(sectors.slice(0, 1), provider);
  expect(next?.row?.return1Y).toBe(31.25);
  expect(next?.row?.returnIntegrity).toEqual({});
  expect(bad).toEqual(original);
  expect(diagnostic?.sourcePoints[0]?.high).toBe(79);
});

test.each(["missing end", "invalid baseline"] as const)("a peer's %s cannot move the shared calendar boundaries", async (failure) => {
  const definitions = [{ name: "Semiconductors", etf: "SMH" }, { name: "Gold Miners", etf: "GDX" }];
  const provider = {
    getQuote: async (symbol: string) => symbol === "SMH" && failure === "missing end" ? null : quote(symbol),
    getPriceHistory: async (symbol: string) => symbol === "SMH" ? [
      { date: new Date("2025-09-10"), close: failure === "invalid baseline" ? NaN : 80 },
      { date: new Date("2026-08-10"), close: failure === "invalid baseline" ? 0 : 90 },
      { date: new Date("2026-09-09"), close: 100 },
    ] : [
      { date: new Date("2025-09-09"), close: 80 },
      { date: new Date("2026-08-07"), close: 90 },
      { date: new Date("2026-09-10"), close: 100 },
    ],
  } as unknown as DataProvider;
  const outcomes = await loadSectorRows(definitions, provider);
  expect(outcomes[0]?.row).toMatchObject({ return1M: null, return1Y: null });
  expect(outcomes[1]?.row).toMatchObject({ price: 105, changePercent: 5, return1M: null, return1Y: null,
    return1MStartDate: null, return1YStartDate: null, returnAsOfDate: "2026-09-10" });
});

test("an extended peer baseline counts even when its ending observation remains unavailable", async () => {
  const provider = {
    getQuote: async (symbol: string) => symbol === "XLK" ? null : quote(symbol),
    getPriceHistory: async (symbol: string) => symbol === "XLK" ? [
      { date: new Date("2026-08-10"), close: 90 },
      { date: new Date("2026-09-09"), close: 100 },
    ] : [
      { date: new Date("2025-09-09"), close: 80 },
      ...history.slice(1),
    ],
    getDetailedPriceHistory: async () => [{ date: new Date("2025-09-10"), close: 80 }],
  } as unknown as DataProvider;
  const rows = await loadSectorRows(sectors, provider);
  expect(rows[0]?.row).toMatchObject({ return1M: null, return1Y: null });
  expect(rows[1]?.row?.return1M).toBeCloseTo(16.6666667);
  expect(rows[1]?.row?.return1Y).toBeNull();
});

test("shared holiday baselines remain valid and a separate history failure cannot erase them", async () => {
  const provider = {
    getQuote: async (symbol: string) => ({ ...quote(symbol), changeSessionDate: "2026-10-12" }),
    getPriceHistory: async (symbol: string) => {
      if (symbol === "XLK") throw new Error("history unavailable");
      return [{ date: new Date("2025-10-10"), close: 100 }, { date: new Date("2026-09-11"), close: 100 }];
    },
  } as unknown as DataProvider;
  const rows = await loadSectorRows(sectors, provider);
  expect(rows[0]?.row).toMatchObject({ price: 105, return1M: null, return1Y: null });
  expect(rows[1]?.row?.return1Y).toBeCloseTo(5);
  expect(rows[1]?.row).toMatchObject({ return1MStartDate: "2026-09-11", return1YStartDate: "2025-10-10" });
});
