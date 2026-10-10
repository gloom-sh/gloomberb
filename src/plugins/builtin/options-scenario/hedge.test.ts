import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneOptionValues } from "../../../types/headless";
import { optionsScenarioHeadless } from "./headless";
import { hedgeInputsFromSettings, parseHedgeAmount, scenarioHedgeBudget, sizeHedgeBudget } from "./hedge";
import { parseLegs, type ScenarioPosition } from "./model";

// SPY on 2026-10-09: the January 2027 700 put quoted 5.48/5.51 against a 778.57 last.
const SPOT = 778.57;
const EXPIRY = Date.UTC(2027, 0, 15) / 1000;
const AS_OF = Date.UTC(2026, 9, 9, 20);
const position = (legs: string): ScenarioPosition => ({ symbol: "SPY", currency: "USD", spot: SPOT, rate: 0.04,
  dividendYield: 0.011, asOf: AS_OF, legs: parseLegs(legs) });
const NAV = { nav: 100_000_000, budgetBps: 50, sleeve: null };

describe("hedge budget inputs", () => {
  test("reads amounts the way they are written", () => {
    expect(["100m", "2.5bn", "250k", "1,000,000", "$100m", "$ 1.5 MM", "3T", 42].map((value) => parseHedgeAmount(value, "nav")))
      .toEqual([1e8, 2.5e9, 2.5e5, 1e6, 1e8, 1.5e6, 3e12, 42]);
    for (const bad of ["abc", "1,00,000", "100x", "m", ""]) expect(() => parseHedgeAmount(bad, "nav")).toThrow("--nav must be an amount");
    for (const bad of ["0", "-5m"]) expect(() => parseHedgeAmount(bad, "sleeve")).toThrow("--sleeve must be greater than zero");
  });

  test("needs NAV and the budget together, and a sleeve only with both", () => {
    expect(hedgeInputsFromSettings({})).toBeNull();
    expect(() => hedgeInputsFromSettings({ nav: "100m" })).toThrow("--nav needs --budget-bps");
    expect(() => hedgeInputsFromSettings({ budgetBps: "50" })).toThrow("--budget-bps needs --nav");
    expect(() => hedgeInputsFromSettings({ sleeve: "100m" })).toThrow("--sleeve needs --nav and --budget-bps");
    for (const bad of ["0", "-5", "fifty", "10001"]) expect(() => hedgeInputsFromSettings({ nav: "100m", budgetBps: bad })).toThrow("--budget-bps");
    expect(hedgeInputsFromSettings({ nav: "$100m", budgetBps: "12.5", sleeve: "80m" })).toEqual({ nav: 1e8, budgetBps: 12.5, sleeve: 8e7 });
  });
});

describe("sizeHedgeBudget", () => {
  test("buys whole contracts at the entry price, and at the ask when the leg was seeded from quotes", () => {
    const put = position("put,700,2027-01-15,1,5.495,20.5");
    const entry = sizeHedgeBudget(put, NAV);
    expect(entry).toMatchObject({ budget: 500_000, basis: "entry", sizingPrice: 5.495, costPerContract: 549.5, contracts: 909,
      premium: 499_495.5, coverage: null });

    const quoted = sizeHedgeBudget(put, { ...NAV, sleeve: 100_000_000 }, { quotes: new Map([["leg-1", { bid: 5.48, ask: 5.51 }]]) });
    // The seed's own contract, priced at its midpoint: the ask. The same leg typed, or saved from the editor: its entry.
    const chain = { underlyingSymbol: "SPY", expirationDates: [EXPIRY], calls: [], puts: [chainContract("P", 700, 5.48, 5.51)] };
    const seeded = { ...put, legs: [{ ...put.legs[0]!, id: chain.puts[0]!.contractSymbol, priceSource: "mid" as const }] };
    expect(scenarioHedgeBudget({ nav: "100m", budgetBps: "50" }, seeded, { chain })?.contracts).toBe(907);
    expect(scenarioHedgeBudget({ nav: "100m", budgetBps: "50" }, { ...seeded, legs: [{ ...seeded.legs[0]!, priceSource: undefined }] }, { chain })?.contracts).toBe(909);
    expect(quoted).toMatchObject({ basis: "quote", sizingPrice: 5.51, costPerContract: 551, contracts: 907, premium: 499_757 });
    expect(quoted.premiumBps).toBeCloseTo(49.9757, 10);
    expect(quoted.notional).toBeCloseTo(907 * 100 * SPOT, 6);
    expect(quoted.notionalOfNav).toBeCloseTo(0.70616, 5);
    expect(quoted.coverage).toBeCloseTo(0.70616, 5);
  });

  test("sizes a spread by its net debit, buying the long leg at the ask and selling the short at the bid", () => {
    const spread = position("put,700,2027-01-15,2,5.495,20.5;put,650,2027-01-15,-2,2.10,24");
    // Two of each is one set of a 1x1 spread: 5.51 - 2.05 = 3.46 a share.
    const hedge = sizeHedgeBudget(spread, NAV, { quotes: new Map([["leg-1", { bid: 5.48, ask: 5.51 }], ["leg-2", { bid: 2.05, ask: 2.15 }]]) });
    expect(hedge).toMatchObject({ basis: "quote", singleLeg: false, sizingPrice: 3.46, contracts: 1445, premium: 1445 * 346 });
    expect(hedge.notional).toBeCloseTo(1445 * 100 * SPOT, 6);
    // At entry prices one leg can be quoted and the other not.
    expect(sizeHedgeBudget(spread, NAV, { quotes: new Map([["leg-1", { bid: 5.48, ask: 5.51 }]]) })).toMatchObject({ basis: "mixed", sizingPrice: 3.41 });
  });

  test("refuses what a budget cannot buy, and says what one contract costs", () => {
    expect(() => sizeHedgeBudget(position("put,700,2027-01-15,-1,5.495,20.5"), NAV)).toThrow("no long option");
    expect(() => sizeHedgeBudget(position("put,700,2027-01-15,1,5.495,20.5;put,750,2027-01-15,-1,12,18"), NAV)).toThrow("net credit of 650.50 USD");
    expect(() => sizeHedgeBudget(position("put,700,2027-01-15,1,5.495,20.5"), { nav: 100_000, budgetBps: 50, sleeve: null },
      { quotes: new Map([["leg-1", { bid: 5.48, ask: 5.51 }]]) }))
      .toThrow("A 50 bps budget of 100,000.00 USD NAV is 500.00 USD; one contract costs 551.00 USD at 5.51 per share, the ask.");
  });
});

function chainContract(side: "C" | "P", strike: number, bid: number, ask: number): OptionContract {
  return { contractSymbol: `SPY270115${side}${String(strike * 1000).padStart(8, "0")}`, strike, currency: "USD", bid, ask,
    lastPrice: (bid + ask) / 2, change: 0, percentChange: 0, volume: 10, openInterest: 100, impliedVolatility: 0.2,
    inTheMoney: false, expiration: EXPIRY, lastTradeDate: AS_OF / 1000 - 60 };
}

/** A headless OSA run against a one-expiry chain, as `fn OSA SPY ...` makes it. */
async function report(options: HeadlessPaneOptionValues): Promise<HeadlessBundleResult> {
  const chain: OptionsChain = { underlyingSymbol: "SPY", expirationDates: [EXPIRY], asOf: new Date(AS_OF).toISOString(), calls: [],
    puts: [chainContract("P", 690, 4.79, 4.83), chainContract("P", 700, 5.48, 5.51), chainContract("P", 710, 6.29, 6.32)] };
  const provider = { id: "hedge-test",
    getQuote: async () => ({ symbol: "SPY", price: SPOT, currency: "USD", change: 0, changePercent: 0, lastUpdated: AS_OF }),
    getTickerFinancials: async () => ({ quote: { symbol: "SPY", price: SPOT, currency: "USD", change: 0, changePercent: 0, lastUpdated: AS_OF },
      fundamentals: { dividendYield: 0.011 }, annualStatements: [], quarterlyStatements: [], priceHistory: [] }),
    getOptionsChain: async () => chain } as unknown as DataProvider;
  const curve = [{ maturity: "3M", maturityYears: 0.25, yield: 4, asOf: "2026-10-08" }, { maturity: "1Y", maturityYears: 1, yield: 4, asOf: "2026-10-08" }];
  return optionsScenarioHeadless.load({ symbols: ["SPY"], rawArgument: "SPY", argument: "SPY", options },
    { marketData: provider, apiClient: { getCloudYieldCurve: async () => curve }, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
}

const hedgeEntries = (result: HeadlessBundleResult) => Object.fromEntries(result.sections.find((section) => section.title === "Hedge budget")!
  .entries!.map((entry) => [entry.key, entry.formatted]));

describe("OSA hedge budget report", () => {
  beforeEach(() => { setSystemTime(AS_OF); });
  afterEach(() => { setSystemTime(); });

  test("one command seeds the protective put from the chain and sizes it on the ask", async () => {
    const result = await report({ strategy: "put", strike: "700", expiration: "2027-01-15", nav: "$100m", budgetBps: "50" });
    expect(result.metadata?.position).toMatchObject({ legs: [{ side: "put", strike: 700, quantity: 1, price: 5.495 }] });
    expect(hedgeEntries(result)).toEqual({
      nav: "100,000,000.00 USD",
      budget: "500,000.00 USD (50 bps of NAV)",
      sizingPrice: "5.51 per share, the ask",
      costPerContract: "551.00 USD (5.51 x 100)",
      contracts: "907",
      premium: "499,757.00 USD",
      premiumBps: "49.98 bps (0.50% of NAV)",
      notional: "70,616,299.00 USD (907 x 100 x 778.57)",
      notionalOfNav: "70.6%",
      coverage: "No equity sleeve given; add --sleeve <amount> to read notional against it",
    });
    expect(hedgeEntries(await report({ strategy: "put", strike: "700", expiration: "2027-01-15", nav: "100m", budgetBps: "50", sleeve: "100m" })).coverage)
      .toBe("70.6% of a 100,000,000.00 USD sleeve");
    await expect(report({ strategy: "put", strike: "705", expiration: "2027-01-15" })).rejects.toThrow("nearest quoted strikes: 690, 700, 710");
  });

  test("a typed position sizes at its entry price, offline, and bad hedge flags fail before any request", async () => {
    const fail = () => { throw new Error("Unexpected market request"); };
    const offline = (options: HeadlessPaneOptionValues) => optionsScenarioHeadless.load({ symbols: ["SPY"], rawArgument: "SPY", argument: "SPY",
      options: { legs: "put,700,2027-01-15,1,5.495,20.5", spot: "778.57", rate: "4", dividendYield: "1.1", currency: "USD", asOf: "2026-10-09", ...options } },
    { marketData: new Proxy({}, { get: fail }), apiClient: new Proxy({}, { get: fail }), signal: new AbortController().signal } as HeadlessPaneContext);
    const typed = await offline({ nav: "100m", budgetBps: "50" });
    expect(hedgeEntries(typed)).toMatchObject({ sizingPrice: "5.495 per share, the entry price", contracts: "909", premium: "499,495.50 USD" });
    expect(scenarioHedgeBudget({ nav: "100m", budgetBps: "50" }, typed.metadata!.position as ScenarioPosition, null)?.contracts).toBe(909);
    await expect(offline({ nav: "100m" })).rejects.toThrow("--nav needs --budget-bps");
    await expect(offline({ nav: "lots", budgetBps: "50" })).rejects.toThrow("--nav must be an amount");
  });
});
