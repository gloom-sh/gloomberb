import { expect, spyOn, test } from "bun:test";
import { serializeCliResult } from "../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";
import { createDefaultConfig } from "../../../types/config";
import type { CorporateActionsData } from "../../../types/financials";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestTicker } from "../../../test-support/ticker";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { showCollection } from "./cli/render";
import { parseDripYears, parseWithholding, projectDrip } from "./income";

test("DRIP buys shares with each year's dividend net of withholding, at a flat price, and converts once into the portfolio's currency; a short owes it in full", () => {
  // 100 shares paying R2.00 a year at R50, 20% withheld, R1 = $0.05.
  const [first, second, third] = projectDrip({ symbol: "SBK", shares: 100, perShare: 2, price: 50, rate: 0.05 }, { years: 3, withholding: 20 });
  // Year 1: R200 gross, R40 withheld, R160 buys 3.2 shares, $8 of income.
  expect(first).toMatchObject({ year: 1, grossIncome: 200, withheld: 40, netIncome: 160, addedShares: 3.2, shares: 103.2, netIncomeBase: 8 });
  expect(first!.valueBase).toBeCloseTo(103.2 * 50 * 0.05, 10);
  // Year 2 pays on 103.2 shares: R206.40 gross, R165.12 net, 3.3024 more shares.
  expect(second!.grossIncome).toBeCloseTo(206.4, 10);
  expect(second!.netIncome).toBeCloseTo(165.12, 10);
  expect(second!.shares).toBeCloseTo(106.5024, 10);
  // Shares compound by 1 + 0.8 * 2 / 50 a year.
  expect(third!.shares).toBeCloseTo(100 * 1.032 ** 3, 10);
  expect(third!.netIncomeBase).toBeCloseTo(100 * 1.032 ** 2 * 2 * 0.8 * 0.05, 10);
  // A short pays the dividend gross every year and buys nothing back.
  for (const year of projectDrip({ symbol: "MO", shares: -10, perShare: 2, price: 50, rate: 1 }, { years: 2, withholding: 20 })) {
    expect(year).toMatchObject({ shares: -10, addedShares: 0, grossIncome: -20, withheld: 0, netIncome: -20, netIncomeBase: -20 });
  }
});

test("--years and --withholding take a whole year count and a percent, and refuse anything else rather than guess", () => {
  expect(parseDripYears(undefined)).toBe(5);
  expect(parseDripYears("3")).toBe(3);
  for (const bad of ["0", "6", "2.5", "3.0", "1e0", "0x3", "", "three"]) expect(() => parseDripYears(bad)).toThrow("--years must be a whole number from 1 to 5");
  expect(parseWithholding(undefined)).toBe(0);
  expect(parseWithholding("15%")).toBe(15);
  expect(parseWithholding("27,5")).toBe(27.5);
  for (const bad of ["-5", "101", "1e2", "abc", ""]) expect(() => parseWithholding(bad)).toThrow("--withholding is a percent from 0 to 100");
});

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const quarterly = (amount: number) => [20, 111, 202, 293, 384, 475, 566, 657].map((ago) => ({ exDate: day(ago), amount }));
const history = (symbol: string, currency: string, dividends: { exDate: string; amount: number }[]): CorporateActionsData =>
  ({ symbol, currency, dividends, splits: [], earnings: [], coverage: { dividends: "available" } });

const position = (shares: number, avgCost: number, currency: string) => ({ portfolio: "main", broker: "manual", shares, avgCost, currency });
const holdings = [
  createTestTicker("KO", "Coca-Cola", { exchange: "NYSE", portfolios: ["main"], positions: [position(100, 60, "USD")] }),
  createTestTicker("SBK", "Standard Bank", { exchange: "JSE", currency: "ZAR", portfolios: ["main"], positions: [position(200, 250, "ZAR")] }),
  createTestTicker("MO", "Altria", { exchange: "NYSE", portfolios: ["main"], positions: [position(-10, 50, "USD")] }),
  createTestTicker("PEP", "PepsiCo", { exchange: "NASDAQ", portfolios: ["main"], positions: [position(10, 150, "USD")] }),
  createTestTicker("BP", "BP", { exchange: "NYSE", portfolios: ["main"], positions: [position(10, 30, "USD")] }),
  createTestTicker("SLOW", "Slow Co", { exchange: "NYSE", portfolios: ["main"], positions: [position(10, 20, "USD")] }),
];
const prices: Record<string, { price: number; currency: string }> = {
  KO: { price: 100, currency: "USD" }, SBK: { price: 300, currency: "ZAR" }, MO: { price: 50, currency: "USD" },
  PEP: { price: 150, currency: "USD" }, BP: { price: 30, currency: "USD" }, SLOW: { price: 20, currency: "USD" },
};
const histories: Record<string, CorporateActionsData> = {
  KO: history("KO", "USD", quarterly(0.5)),
  // Cents: 900c a half-year is R18.00 a year.
  SBK: history("SBK", "ZAc", [30, 212, 395, 577].map((ago) => ({ exDate: day(ago), amount: 900 }))),
  MO: history("MO", "USD", quarterly(0.5)),
  // The source has no history for it: unknown, not a non-payer.
  PEP: { ...history("PEP", "USD", []), coverage: { dividends: "unavailable" } },
  // Paid in pounds, with no pound rate to the portfolio's dollars.
  BP: history("BP", "GBP", quarterly(0.06)),
};

function market(getCorporateActions: (symbol: string) => Promise<CorporateActionsData>, format?: "json") {
  return createTestCliContext({
    config: createDefaultConfig("/unused-income"),
    store: { loadAllTickers: async () => holdings },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, ...prices[symbol]!, change: 0, changePercent: 0, previousClose: prices[symbol]!.price, lastUpdated: Date.now() }),
      getExchangeRate: async (currency) => { if (currency === "GBP") throw new Error("No rate"); return currency === "ZAR" ? 0.05 : 1; },
      getCorporateActions: async (symbol) => getCorporateActions(symbol),
    }),
  }, format ? { format } : {});
}

async function text(run: () => Promise<void>): Promise<string> {
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await run(); } finally { logger.mockRestore(); }
  return output.join("\n");
}

test("portfolio show reads cents in rand, converts income, owes a short's dividend, and names each unknown holding's cause in one line without counting it as $0", async () => {
  // SLOW never answers: the shared deadline leaves it unread.
  const read = (symbol: string) => histories[symbol] ? Promise.resolve(histories[symbol]!) : new Promise<CorporateActionsData>(() => {});
  setCliColorEnabledOverride(false);
  try {
    const cli = market(read, "json");
    await showCollection("main", cli.context, { dividendDeadlineMs: 50 });
    const exported = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, cli.printed[0]!.options));
    // KO $2.00 on 100 shares, SBK R18.00 on 200 shares at 0.05, MO's short owes $2.00 on 10.
    expect(exported.metadata).toMatchObject({ annualIncome: null, portfolioYield: null, incomeComplete: false, complete: false });
    expect(exported.metadata.knownAnnualIncome).toBeCloseTo(200 + 180 - 20, 8);
    expect(exported.metadata.incomeUnavailable).toEqual([
      { symbol: "BP", cause: "fx", currency: "GBP" }, { symbol: "PEP", cause: "no-history" }, { symbol: "SLOW", cause: "unread", why: "timed-out" },
    ]);
    const row = (symbol: string) => exported.data.find((entry: { symbol: string }) => entry.symbol === symbol);
    expect(row("SBK")).toMatchObject({ dividendPerShare: 18, dividendCurrency: "ZAR", annualIncome: 180, incomeYield: 6 });
    expect(row("MO")).toMatchObject({ annualIncome: -20, incomeYield: -4 });
    expect(row("PEP")).toMatchObject({ annualIncome: null, incomeYield: null });

    const shown = await text(() => showCollection("main", market(read).context, { dividendDeadlineMs: 50, drip: { years: 1, withholding: 20 } }));
    expect(shown).toMatch(/SBK[^\n]*\$180\.00 +6\.00%/);
    expect(shown).toMatch(/PEP[^\n]*— +— /);
    expect(shown).toMatch(/TOTAL[^\n]*100\.0% +— +— /);
    expect(shown).toContain("Income unavailable: no GBP exchange rate for BP:NYSE; no dividend history for PEP:NASDAQ; "
      + "dividends not read within 0.05s for SLOW:NYSE. The other 3 holdings pay $360.00 a year.");
    // The short's cost repeats in the projection, nothing reinvested; unknown holdings are not projected.
    expect(shown).toMatch(/MO:NYSE +-10 +-10 +-\$20\.00/);
    expect(shown).toContain("Not projected: BP:NYSE, PEP:NASDAQ, SLOW:NYSE (income unavailable above).");

    // Offline: no holding's income is known, so the columns give way to one line.
    const offline = await text(() => showCollection("main", market(() => Promise.reject(new TypeError("fetch failed"))).context));
    expect(offline).not.toContain("Income  ");
    expect(offline).not.toMatch(/KO[^\n]*—[^\n]*—[^\n]*—/);
    expect(offline).toContain("Income not shown: dividends not read (offline?) for BP:NYSE, KO:NYSE, MO:NYSE, PEP:NASDAQ, SBK:JSE, SLOW:NYSE.");
  } finally {
    setCliColorEnabledOverride(null);
  }
});
