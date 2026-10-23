import { expect, test } from "bun:test";
import type { DataProvider, EarningsEvent } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import type { ImpliedVolatilityApi } from "../iv-history/client";
import { createScenarioDependencies } from "./client";
import type { CashSecuredPut } from "./csp";
import { loadCspScreen, nearestListedExpiry, rankCspScreen, readCspScreenCriteria, type CspScreenRow } from "./csp-screen";

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

test("criteria default to the 0.30 delta put 30 days out, flagged wide over 10%, and refuse what they cannot read", () => {
  expect(readCspScreenCriteria({})).toEqual({ delta: 0.3, days: 30, expiration: null, maxSpreadPercent: 10 });
  // A put's delta reads with or without its sign; a spread limit with or without its percent sign.
  expect(readCspScreenCriteria({ delta: "-0.20", days: "45", maxSpread: "15%" })).toEqual({ delta: 0.2, days: 45, expiration: null, maxSpreadPercent: 15 });
  expect(readCspScreenCriteria({ expiration: day("2026-11-20") }).expiration).toBe(day("2026-11-20"));
  expect(() => readCspScreenCriteria({ delta: "30" })).toThrow("between 0 and 1");
  expect(() => readCspScreenCriteria({ days: "0" })).toThrow("whole calendar days");
  expect(() => readCspScreenCriteria({ maxSpread: "0" })).toThrow("above 0");
  expect(() => readCspScreenCriteria({ days: "30", expiration: day("2026-11-20") })).toThrow("give one of them");
});

test("each name takes its listed expiry nearest the target date, the earlier on a tie", () => {
  const listed = ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-18"].map(day);
  expect(nearestListedExpiry(listed, "2026-11-21")).toBe(day("2026-11-20"));
  expect(nearestListedExpiry(listed, "2026-12-06")).toBe(day("2026-11-27"));
  // Equally far from the 16th and the 20th of a list without the 18th: the earlier.
  expect(nearestListedExpiry([day("2026-11-16"), day("2026-11-20")], "2026-11-18")).toBe(day("2026-11-16"));
  expect(nearestListedExpiry([], "2026-11-18")).toBeUndefined();
});

test("the ranking is by yield at the bid: a wide spread is ranked and flagged, a name with no put follows without a rank", () => {
  const put = (bidAnnualizedYield: number | null, annualizedYield: number) =>
    ({ annualizedYield, quote: bidAnnualizedYield == null ? null : { bidAnnualizedYield } }) as unknown as CashSecuredPut;
  const row = (symbol: string, csp: CashSecuredPut | null, wideSpread = false): Omit<CspScreenRow, "rank"> =>
    ({ symbol, csp, delta: null, ivRank: null, wideSpread, note: csp ? null : "Options chain unavailable" });
  const ranked = rankCspScreen([
    row("KO", put(0.12, 0.13)),
    row("ZZZ", null),
    // The highest yield at the mid, but its wide spread gives back most of it at the bid.
    row("GS", put(0.10, 0.20), true),
    row("JPM", put(0.15, 0.16)),
    row("AAA", null),
  ]);
  expect(ranked.map((entry) => [entry.rank, entry.symbol, entry.wideSpread])).toEqual([
    [1, "JPM", false], [2, "KO", false], [3, "GS", true], [null, "AAA", false], [null, "ZZZ", false],
  ]);
});

test("the screen sells each name's put nearest the delta, reads it as OSA does, and ranks the names by yield at the bid", async () => {
  const now = Date.parse("2026-10-21T18:00:00Z");
  const expiry = day("2026-11-20");
  const strikes = [85, 87.5, 90, 92.5, 95, 97.5, 100, 102.5, 105];
  const years = daysToExpiryFrom(expiry, now);
  // Two names on one model at 30% vol; BBB's quotes are a dollar wide either side of the mid.
  const halfSpread: Record<string, number> = { AAA: 0.02, BBB: 0.5 };
  const chain = (symbol: string): OptionsChain => {
    const contract = (side: "call" | "put", strike: number) => {
      const { price } = valueOption({ side, spot: 100, strike, daysToExpiry: years, rate: 0.04, dividendYield: 0.01, volatility: 0.3 });
      const bid = Math.max(0.01, price - halfSpread[symbol]!);
      return { contractSymbol: `${symbol}${side}${strike}`, strike, bid, ask: bid + 2 * halfSpread[symbol]!, currency: "USD", expiration: expiry,
        impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: now / 1000 };
    };
    return { underlyingSymbol: symbol, expirationDates: [day("2026-10-23"), expiry, day("2026-12-18")], asOf: new Date(now).toISOString(),
      calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) };
  };
  const quote = (symbol: string): Quote => ({ symbol, price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: now });
  const provider = {
    id: "csp-screen-test",
    getQuote: async (symbol: string) => quote(symbol),
    getTickerFinancials: async (symbol: string) => ({ quote: quote(symbol), fundamentals: { dividendYield: 0.01 }, annualStatements: [],
      quarterlyStatements: [], priceHistory: [] }) as TickerFinancials,
    getOptionsChain: async (symbol: string) => {
      if (symbol === "NOPE") throw new Error("Not a ticker: NOPE.");
      return chain(symbol);
    },
    getEarningsCalendar: async () => [{ symbol: "AAA", name: "AAA", earningsDate: new Date("2026-11-05T00:00:00Z"), epsEstimate: null }] as EarningsEvent[],
  } as unknown as DataProvider;
  const ivApi = { impliedVolatility: async () => ({ version: 1, asOf: "2026-10-20", rows: [
    { symbol: "AAA", status: "ready", iv30: { rank: 42 }, iv90: null, latest: null, skew: null },
    { symbol: "BBB", status: "ready", iv30: { rank: null, rankNote: "fewer than 120 sessions" }, iv90: null, latest: null, skew: null },
  ] }) } as unknown as ImpliedVolatilityApi;
  const scenario = { ...createScenarioDependencies(provider, { getCloudYieldCurve: async () => [
    { maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-10-20" }, { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-20" }] }),
  now: () => now };
  const screen = await loadCspScreen(["AAA", "BBB", "NOPE"].map((symbol) => ({ symbol })), readCspScreenCriteria({}),
    { scenario, earnings: provider, ivApi });

  // The put whose delta at 30% vol is nearest -0.30, priced on its own.
  const deltaOf = (strike: number) => valueOption({ side: "put", spot: 100, strike, daysToExpiry: years, rate: 0.04, dividendYield: 0.01,
    volatility: 0.3 }).delta;
  const nearest = strikes.reduce((best, strike) => Math.abs(deltaOf(strike) + 0.3) < Math.abs(deltaOf(best) + 0.3) ? strike : best);
  const [first, second, missing] = screen.rows;
  // Both sell the same strike; the tight quotes keep more of the premium at the bid, so AAA ranks first.
  expect([first!.symbol, first!.rank, first!.csp!.strike, first!.csp!.expiry]).toEqual(["AAA", 1, nearest, "2026-11-20"]);
  expect([second!.symbol, second!.rank, second!.csp!.strike]).toEqual(["BBB", 2, nearest]);
  expect(first!.delta!).toBeCloseTo(deltaOf(nearest), 2);
  expect(first!.csp!.quote!.bidAnnualizedYield!).toBeGreaterThan(second!.csp!.quote!.bidAnnualizedYield!);
  // BBB's dollar-wide quotes are over 10% of the mid: flagged, still ranked.
  expect([first!.wideSpread, second!.wideSpread]).toEqual([false, true]);
  expect([first!.ivRank, second!.ivRank]).toEqual([42, null]);
  expect(first!.csp!.earnings).toEqual({ date: "2026-11-05", beforeExpiry: true });
  // A name with no chain is listed last with why, never dropped.
  expect([missing!.symbol, missing!.rank, missing!.csp, missing!.note]).toEqual(["NOPE", null, null, "Options chain: Not a ticker: NOPE."]);
  expect(screen.missingRanks).toEqual(["BBB (fewer than 120 sessions)"]);
});
