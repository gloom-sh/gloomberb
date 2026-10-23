import { expect, setSystemTime, test } from "bun:test";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
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

test("selling at the bid: GS's November 820 put at 5.40/6.75 yields 8.01% a year at the bid against 9.01% at the mid", () => {
  const gs: ScenarioPosition = { symbol: "GS", currency: "USD", spot: 890, rate: 0.041, dividendYield: 0.0225, asOf: Date.parse("2026-10-21T18:00:00Z"),
    legs: [{ id: "GS261120P00820000", side: "put", quantity: -1, strike: 820, expiration: expiry, price: 6.075, priceSource: "mid",
      volatility: 0.33, volatilitySource: "mid", multiplier: 100 }] };
  const csp = cashSecuredPut(gs, "implied by option quotes", null, { bid: 5.4, ask: 6.75 })!;
  expect(csp.daysToExpiry).toBe(30);
  expect(csp.annualizedYield!).toBeCloseTo(607.5 / 82_000 * 365 / 30, 12);
  expect(csp.quote).toMatchObject({ bid: 5.4, ask: 6.75, spread: 1.35, bidPremium: 540 });
  expect(csp.quote!.spreadOfMid).toBeCloseTo(1.35 / 6.075, 12);
  expect(csp.quote!.bidYieldOnCash).toBeCloseTo(540 / 82_000, 12);
  expect(csp.quote!.bidAnnualizedYield!).toBeCloseTo(540 / 82_000 * 365 / 30, 12);
  const formatted = Object.fromEntries(cspReportEntries(csp).map((entry) => [entry.key, entry.formatted]));
  expect([formatted.annualizedYield, formatted.bid, formatted.ask, formatted.spread, formatted.bidPremium, formatted.bidAnnualizedYield]).toEqual([
    "9.01% (yield on cash x 365 / 30)", "5.40 per share", "6.75 per share", "1.35 per share (22.2% of the mid)",
    "540.00 USD (5.40 x 100 x 1)", "8.01% (0.66% on cash x 365 / 30)"]);
  // A put with no two-sided quote (typed by hand) has no bid figures rather than a zero.
  expect(cashSecuredPut(gs, "typed", null, { bid: 0, ask: 6.75 })!.quote).toBeNull();
  expect(cspReportEntries(cashSecuredPut(gs, "typed", null)!).some((entry) => entry.key === "bid")).toBe(false);
});

test("the CSV writes each cash-secured put figure as a number, with its unit in the unit column", () => {
  const csp = cashSecuredPut(position, "implied by option quotes", "2026-10-27", { bid: 0.67, ask: 0.72 })!;
  const result: HeadlessBundleResult = { sections: [{ title: "Cash-secured put", entries: cspReportEntries(csp) }], complete: true,
    unavailableSymbols: [], errors: [] };
  const definition = { ...optionsScenarioHeadless, freshness: { source: "Gloom Cloud", status: "not-a-feed" as const, asOf: "2026-10-13" } };
  const args = { symbols: ["KO"], rawArgument: "KO", argument: "KO", options: {} };
  const freshness = deriveHeadlessFreshness(definition, result);
  const csv = renderReportCsv(headlessReportTables(definition, result, args, "OSA", freshness, { complete: true, unavailableSymbols: [] }), freshness)
    .split("\n").map((line) => line.split(","));
  // Metric, value and unit.
  const row = (metric: string) => { const cells = csv.find((line) => line[0] === metric); return cells && [cells[0], cells[1], cells[3]]; };
  expect(csv[0]).toEqual(["Metric", "Value", "symbol_or_series", "currency_or_unit", "interval", "source", "as_of"]);
  expect(row("Cash secured (USD)")).toEqual(["Cash secured (USD)", "8500", "USD"]);
  expect(row("Annualised yield at the bid (%)")).toEqual(["Annualised yield at the bid (%)", "7.57120743034", "%"]);
  expect(row("Spread (% of mid)")?.[2]).toBe("% of mid");
  expect(row("Break-even (USD per share)")).toEqual(["Break-even (USD per share)", "84.305", "USD per share"]);
  expect(row("Days to expiry")).toEqual(["Days to expiry", "38", "days"]);
  // A figure with no unit, such as the earnings flag, leaves the column blank rather than borrowing another's.
  expect(row("Earnings before expiry")?.[2]).toBe("");
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
  const curve = async () => [{ maturity: "1M", maturityYears: 1 / 12, yield: 4, asOf: "2026-10-12" },
    { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-12" }];
  const load = (options: Record<string, string>, getCloudYieldCurve = curve, rawArgument = "KO") => optionsScenarioHeadless.load(
    { symbols: ["KO"], rawArgument, argument: "KO", options: { strategy: "csp", expiration: String(expiry), ...options } },
    { marketData: provider, signal: new AbortController().signal, apiClient: { getCloudYieldCurve } } as unknown as HeadlessPaneContext);
  setSystemTime(now);
  try {
    const result = await load({ strike: "85" });
    expect(result.errors).toEqual([]);
    const metadata = result.metadata as { position: ScenarioPosition; csp: ReturnType<typeof cashSecuredPut> };
    expect(metadata.position.legs.map((leg) => [leg.side, leg.strike, leg.quantity, leg.priceSource])).toEqual([["put", 85, -1, "mid"]]);
    const mid = (chain.puts[0]!.bid + chain.puts[0]!.ask) / 2;
    expect(metadata.csp!.premium).toBeCloseTo(mid * 100, 5);
    expect(metadata.csp!.earnings).toEqual({ date: null, beforeExpiry: null });
    const section = result.sections.find((entry) => entry.title === "Cash-secured put");
    expect(section?.entries?.find((entry) => entry.key === "earningsBeforeExpiry")?.formatted).toBe("unknown (no upcoming date published)");

    // Percents in the sections are whole and rounded (7, not 7.000000000000001); the metadata keeps the model's fractions.
    const typed = await load({ strike: "85", rate: "4.1", dividendYield: "7" });
    const inputs = typed.sections.find((entry) => entry.title === "Inputs")?.entries ?? [];
    expect(["rate", "dividendYield"].map((key) => inputs.find((entry) => entry.key === key)?.value)).toEqual([4.1, 7]);
    expect((typed.metadata as { position: ScenarioPosition }).position.dividendYield).toBe(0.07);

    // The put is picked by delta or by strike, never both, and by delta only with a Treasury rate to price it.
    await expect(load({ strike: "85", delta: "0.3" })).rejects.toThrow("delta and strike each pick the put; give one of them");
    const noCurve = async () => { throw new Error("Treasury curve unavailable"); };
    await expect(load({ delta: "0.3" }, noCurve)).rejects.toThrow("Choosing the put by delta needs the Treasury rate; supply --rate, or pick it with --strike");
    expect((await load({ delta: "0.3", rate: "4" }, noCurve)).errors).toEqual([]);
    await expect(load({}, curve, "KO JPM")).rejects.toThrow("OSA values one underlying. To rank cash-secured puts across KO, JPM: gloom fn CSP KO JPM");
  } finally { setSystemTime(); }
});
