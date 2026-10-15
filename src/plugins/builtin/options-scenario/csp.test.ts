import { expect, setSystemTime, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { HeadlessPaneContext } from "../../../types/headless";
import { daysToExpiryFrom, valueOption } from "../shared/volatility";
import { cashSecuredPut, cspReportEntries, earningsBeforeExpiry } from "./csp";
import { optionsScenarioHeadless } from "./headless";
import type { ScenarioPosition } from "./model";

const expiry = Date.UTC(2026, 10, 20) / 1000;
// KO's November 85 put at 0.67/0.72, sold at the 0.695 midpoint, valued Tuesday 13 October before the open.
const position: ScenarioPosition = {
  symbol: "KO", currency: "USD", spot: 89.98, rate: 0.0415, dividendYield: 0.0234, asOf: Date.parse("2026-10-13T12:35:00Z"),
  legs: [{ id: "KO261120P00085000", side: "put", quantity: -1, strike: 85, expiration: expiry, price: 0.695, priceSource: "mid",
    volatility: 0.2175, volatilitySource: "mid", multiplier: 100 }],
};

test("a cash-secured put reads cash, premium, yields, distance, break-even and days to expiry off the position", () => {
  const csp = cashSecuredPut(position, "implied by option quotes", "2026-10-27")!;
  expect(csp.cashSecured).toBe(8_500);
  expect(csp.premium).toBe(69.5);
  expect(csp.yieldOnCash).toBeCloseTo(69.5 / 8_500, 12);
  expect(csp.daysToExpiry).toBe(38);
  expect(csp.annualizedYield!).toBeCloseTo(69.5 / 8_500 * 365 / 38, 12);
  expect(csp.outOfTheMoney!).toBeCloseTo((89.98 - 85) / 89.98, 12);
  expect(csp.breakEven).toBeCloseTo(84.305, 12);
  expect(csp.earnings).toEqual({ date: "2026-10-27", beforeExpiry: true });
  // Every figure says what it is made of, so it can be checked by hand.
  expect(Object.fromEntries(cspReportEntries(csp).map((entry) => [entry.label, entry.formatted]))).toEqual({
    "Cash secured": "8,500.00 USD (85 x 100 x 1)",
    "Premium received": "69.50 USD (0.695 per share, quote mid)",
    "Yield on cash": "0.82% (69.50 / 8,500.00)",
    "Annualised yield": "7.85% (yield on cash x 365 / 38)",
    "Out of the money": "5.5% below spot 89.98 (implied by option quotes)",
    "Break-even": "84.305 per share (85 - 0.695)",
    "Days to expiry": "38 (2026-10-13 to 2026-11-20)",
    "Earnings before expiry": "yes (next report 2026-10-27)",
  });
  // Two contracts secure twice the cash for the same yield; anything but one short put is not a cash-secured put.
  const two = cashSecuredPut({ ...position, legs: [{ ...position.legs[0]!, quantity: -2 }] }, "typed", null)!;
  expect([two.cashSecured, two.premium, two.yieldOnCash]).toEqual([17_000, 139, csp.yieldOnCash]);
  expect(cashSecuredPut({ ...position, legs: [{ ...position.legs[0]!, quantity: 1 }] }, "typed", null)).toBeNull();
  expect(cashSecuredPut({ ...position, legs: [{ ...position.legs[0]!, side: "call" }] }, "typed", null)).toBeNull();
});

test("days to expiry count from the valuation date in New York, and earnings are unknown without an upcoming date", () => {
  // 22:00 New York on 13 October is already the 14th in UTC.
  const evening = cashSecuredPut({ ...position, asOf: Date.parse("2026-10-14T02:00:00Z") }, "typed", null)!;
  expect([evening.valuationDate, evening.daysToExpiry]).toEqual(["2026-10-13", 38]);
  expect(evening.earnings).toEqual({ date: null, beforeExpiry: null });
  expect(cspReportEntries(evening).find((entry) => entry.key === "earningsBeforeExpiry")?.formatted).toBe("unknown (no upcoming date published)");
  expect(earningsBeforeExpiry("2026-11-20", "2026-10-13", "2026-11-20")).toEqual({ date: "2026-11-20", beforeExpiry: true });
  expect(earningsBeforeExpiry("2027-02-10", "2026-10-13", "2026-11-20")).toEqual({ date: "2027-02-10", beforeExpiry: false });
  // A calendar still holding the last report has no next date to compare.
  expect(earningsBeforeExpiry("2026-07-21", "2026-10-13", "2026-11-20")).toEqual({ date: null, beforeExpiry: null });
  // On the expiry day there is nothing left to annualise.
  const lastDay = cashSecuredPut({ ...position, asOf: Date.parse("2026-11-20T15:00:00Z") }, "typed", null)!;
  expect([lastDay.daysToExpiry, lastDay.annualizedYield]).toEqual([0, null]);
});

test("--strategy csp sells the put at its midpoint and reports it, with earnings unknown when the calendar has no date", async () => {
  const now = Date.parse("2026-10-13T14:00:00Z");
  const contract = (side: "call" | "put", strike: number) => {
    const { price } = valueOption({ side, spot: 90, strike, daysToExpiry: daysToExpiryFrom(expiry, now), rate: 0.04,
      dividendYield: 0.0234, volatility: 0.22 });
    return { contractSymbol: `KO${side}${strike}`, strike, bid: price - 0.02, ask: price + 0.02, currency: "USD", expiration: expiry,
      impliedVolatility: 0, lastPrice: 0, change: 0, percentChange: 0, inTheMoney: false, lastTradeDate: now / 1000 };
  };
  const strikes = [85, 87.5, 90, 92.5];
  const chain: OptionsChain = { underlyingSymbol: "KO", expirationDates: [expiry], asOf: new Date(now).toISOString(),
    calls: strikes.map((strike) => contract("call", strike)), puts: strikes.map((strike) => contract("put", strike)) };
  const quote: Quote = { symbol: "KO", price: 90, currency: "USD", change: 0, changePercent: 0, lastUpdated: now };
  const financials: TickerFinancials = { quote, fundamentals: { dividendYield: 0.0234 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
  const provider = { id: "csp-test", getQuote: async () => quote, getTickerFinancials: async () => financials,
    getOptionsChain: async () => chain, getEarningsCalendar: async () => [] } as unknown as DataProvider;
  setSystemTime(now);
  try {
    const result = await optionsScenarioHeadless.load({ symbols: ["KO"], rawArgument: "KO", argument: "KO",
      options: { strategy: "csp", strike: "85", expiration: String(expiry) } }, { marketData: provider, signal: new AbortController().signal,
      apiClient: { getCloudYieldCurve: async () => [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-10-12" },
        { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-12" }] } } as unknown as HeadlessPaneContext);
    expect(result.errors).toEqual([]);
    const metadata = result.metadata as { position: ScenarioPosition; csp: ReturnType<typeof cashSecuredPut> };
    expect(metadata.position.legs.map((leg) => [leg.side, leg.strike, leg.quantity, leg.priceSource])).toEqual([["put", 85, -1, "mid"]]);
    const mid = (chain.puts[0]!.bid + chain.puts[0]!.ask) / 2;
    expect(metadata.csp!.premium).toBeCloseTo(mid * 100, 5);
    expect(metadata.csp!.earnings).toEqual({ date: null, beforeExpiry: null });
    const section = result.sections.find((entry) => entry.title === "Cash-secured put");
    expect(section?.entries?.find((entry) => entry.key === "earningsBeforeExpiry")?.formatted).toBe("unknown (no upcoming date published)");
  } finally { setSystemTime(); }
});
