import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint, Quote } from "../../../types/financials";
import { loadSectorRows } from "./client";
import { projectSectorRows } from "./headless";
import { sessionQuotes } from "../../../test-support/test-fixture-session-quotes";

const sectors = [
  { name: "Technology", etf: "XLK" },
  { name: "Financials", etf: "XLF" },
];
const quote = (symbol: string): Quote => ({
  symbol, price: 105, change: 5, changePercent: 5, currency: "USD", lastUpdated: Date.parse("2026-09-10T18:00:00Z"), changeSessionDate: "2026-09-10",
});
const history: PricePoint[] = [
  { date: new Date("2025-09-10"), close: 80 },
  { date: new Date("2026-08-10"), close: 90 },
  { date: new Date("2026-09-10"), close: 100 },
];

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
  const requestedStarts: string[] = [];
  const sessionQuote = { ...quote("XLK"), changeSessionDate: "2026-10-12", lastUpdated: Date.parse("2026-10-12T18:00:00Z") };
  const provider = {
    getQuote: async () => sessionQuote,
    getPriceHistory: async () => [{ date: new Date("2025-10-13"), close: 101 }, { date: new Date("2026-10-12"), close: 104 }],
    getDetailedPriceHistory: async (_symbol: string, _exchange: string, start: Date) => {
      requestedStarts.push(start.toISOString().slice(0, 10));
      return [{ date: new Date("2025-10-10"), close: 100 }];
    },
  } as unknown as DataProvider;
  const [result] = await loadSectorRows(sectors.slice(0, 1), provider);
  expect(requestedStarts.at(-1)).toBe("2025-09-28");
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

describe("sectors before the open", () => {
  // Monday 2026-10-12 06:00 ET. Friday closed at 198.78, up 1.00 from 197.78.
  const board = [
    { name: "Technology", etf: "XLK" }, { name: "Healthcare", etf: "XLV" }, { name: "Consumer Disc.", etf: "XLY" },
    { name: "Industrials", etf: "XLI" }, { name: "Utilities", etf: "XLU" },
  ];
  const fridayHistory = (complete = true): PricePoint[] => [
    { date: new Date("2025-10-09"), close: 150 }, { date: new Date("2026-09-09"), close: 180 },
    { date: new Date("2026-10-08"), close: 197.78 }, ...(complete ? [{ date: new Date("2026-10-09"), close: 198.78 }] : []),
  ];
  const { preMarket, afterHours } = sessionQuotes();
  // Gloom Cloud carries the prior close with a thin fund's quote, nothing having traded today.
  const noPrint = (symbol: string): Quote => ({
    ...preMarket, symbol, price: 198.78, change: 0, changePercent: 0, previousClose: 198.78, extendedSessionPrint: false,
    preMarketPrice: undefined, preMarketChange: undefined, preMarketChangePercent: undefined, lastUpdated: Date.parse("2026-10-09T23:50:00Z"),
  });
  const withoutClose = (symbol: string): Quote => ({
    ...preMarket, symbol, regularClose: undefined, regularCloseSessionDate: undefined, regularChange: undefined, regularChangePercent: undefined,
  });
  const load = (fundQuote: (symbol: string) => Quote, others: readonly string[], history = (_symbol: string) => fridayHistory()) => loadSectorRows(board, {
    getQuote: async (symbol: string) => others.includes(symbol) ? fundQuote(symbol) : { ...preMarket, symbol },
    getPriceHistory: async (symbol: string) => history(symbol),
  } as unknown as DataProvider);

  test.each<[string, (symbol: string) => Quote, "PRE" | null]>([
    ["has no pre-market print yet", noPrint, null],
    ["is still the after-hours snapshot, flagged stale", (symbol) => ({ ...afterHours, symbol, stale: true }) as Quote, null],
    ["measures its previous close from a dividend-adjusted price", (symbol) => ({ ...preMarket, symbol, previousClose: 196.9 }) as Quote, "PRE"],
  ])("a fund whose quote %s still ranks beside the funds that printed", async (_name, quoteOf, extended) => {
    const rows = await load(quoteOf, ["XLV", "XLI", "XLU"]);
    for (const { etf, row } of rows) {
      expect(row, etf).toMatchObject({ price: 198.78, quoteIssue: null, quoteSessionDate: "2026-10-09", returnAsOfDate: "2026-10-09" });
      expect(row?.changePercent, etf).toBeCloseTo(0.5056, 4);
      expect(row?.return1M, etf).toBeCloseTo((198.78 / 180 - 1) * 100, 6);
      // Only a fund with a current pre-market print has one beside its close.
      expect(row?.extendedSession ?? null, etf).toBe(["XLK", "XLY"].includes(etf) ? "PRE" : extended);
    }
  });

  test("a stale quote in the regular session is not a close and stays blank", async () => {
    const rows = await load((symbol) => ({ ...sessionQuotes(symbol).regular, stale: true }) as Quote, ["XLV"]);
    expect(rows.find(({ etf }) => etf === "XLV")?.row).toMatchObject({ price: null, quoteIssue: expect.stringContaining("stale quote from") });
  });

  test("a quote that cannot say which close it follows blanks only itself, with the reason", async () => {
    // No close sent and a history one session behind: its session cannot be confirmed.
    const rows = await load(withoutClose, ["XLV", "XLU"], (symbol) => fridayHistory(symbol !== "XLV" && symbol !== "XLU"));
    for (const { etf, row } of rows) {
      if (etf === "XLV" || etf === "XLU") expect(row).toMatchObject({ price: null, changePercent: null, quoteIssue: "pre-market quote without a confirmed last close" });
      else expect(row).toMatchObject({ price: 198.78, quoteIssue: null, returnAsOfDate: "2026-10-09" });
    }
    // With no fund able to confirm it, the board keeps the quotes it was given.
    const alone = await load(withoutClose, board.map(({ etf }) => etf), () => fridayHistory(false));
    expect(alone.every(({ row }) => row?.price != null && row.returnAsOfDate === "2026-10-12")).toBe(true);
  });

  test("a fund with no quote shows a dash with the reason while its returns stay", async () => {
    const provider = {
      getQuote: async (symbol: string) => { if (symbol === "XLU") throw new Error("no quote"); return { ...preMarket, symbol }; },
      getPriceHistory: async () => fridayHistory(),
    } as unknown as DataProvider;
    const rows = await loadSectorRows(board, provider);
    expect(rows.find(({ etf }) => etf === "XLU")?.row).toMatchObject({ price: null, changePercent: null, quoteIssue: "quote unavailable", returnAsOfDate: "2026-10-09" });
    expect(rows.find(({ etf }) => etf === "XLU")?.row?.return1Y).toBeCloseTo((198.78 / 150 - 1) * 100, 6);
    expect(rows.find(({ etf }) => etf === "XLK")?.row?.price).toBe(198.78);
  });
});
