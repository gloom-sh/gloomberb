import { expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { serializeCliResult } from "../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";
import { createDefaultConfig } from "../../../types/config";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestCliContext } from "../../../test-support/cli-context";
import { createTestTicker } from "../../../test-support/ticker";
import { setCliColorEnabledOverride } from "../../../utils/cli-output";
import { showCollection } from "./cli/render";
import { parseDripYears, parseWithholding, projectDrip } from "./income";

test("DRIP buys shares with each year's dividend net of withholding, at a flat price, and converts once into the portfolio's currency", () => {
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
  // Nothing withheld keeps the whole dividend.
  expect(projectDrip({ symbol: "KO", shares: 10, perShare: 2, price: 100, rate: 1 }, { years: 1, withholding: 0 })[0]!.shares).toBeCloseTo(10.2, 10);
});

test("--years and --withholding take a whole year count and a percent, and refuse anything else rather than guess", () => {
  expect(parseDripYears(undefined)).toBe(5);
  expect(parseDripYears("3")).toBe(3);
  for (const bad of ["0", "6", "2.5", "", "three"]) expect(() => parseDripYears(bad)).toThrow("--years must be a whole number from 1 to 5");
  expect(parseWithholding(undefined)).toBe(0);
  expect(parseWithholding("15")).toBe(15);
  expect(parseWithholding("15%")).toBe(15);
  expect(parseWithholding("27,5")).toBe(27.5);
  for (const bad of ["-5", "101", "1e2", "abc", ""]) expect(() => parseWithholding(bad)).toThrow("--withholding is a percent from 0 to 100");
});

test("portfolio show reads a cash history paid in cents in rand, converts income into the portfolio's currency, and withholds the total when a payer's history is unknown", async () => {
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const quarterly = (amount: number) => [20, 111, 202, 293, 384, 475, 566, 657].map((ago) => ({ exDate: day(ago), amount }));
  const semiannual = (amount: number) => [30, 212, 395, 577].map((ago) => ({ exDate: day(ago), amount }));
  const histories: Record<string, { currency: string; dividends: { exDate: string; amount: number }[] }> = {
    KO: { currency: "USD", dividends: quarterly(0.5) },
    // Cents: 900c a half-year is R18.00 a year.
    SBK: { currency: "ZAc", dividends: semiannual(900) },
  };
  const spy = spyOn(apiClient, "getMarketDividends").mockImplementation(async (symbol: string) => {
    const history = histories[symbol];
    if (!history) throw new Error("Controlled dividend read failure");
    return { status: "success", data: { quote: null, summary: null,
      actions: { providerId: "gloomberb-cloud", symbol, currency: history.currency, dividends: history.dividends, splits: [], earnings: [], coverage: { dividends: "available" } } } };
  });
  const position = (shares: number, avgCost: number, currency: string) => ({ portfolio: "main", broker: "manual", shares, avgCost, currency });
  const ko = createTestTicker("KO", "Coca-Cola", { exchange: "NYSE", portfolios: ["main"], positions: [position(100, 60, "USD")] });
  const sbk = createTestTicker("SBK", "Standard Bank", { exchange: "JSE", currency: "ZAR", portfolios: ["main"], positions: [position(200, 250, "ZAR")] });
  const pep = createTestTicker("PEP", "PepsiCo", { exchange: "NASDAQ", portfolios: ["main"], positions: [position(10, 150, "USD")] });
  const prices: Record<string, { price: number; currency: string }> = { KO: { price: 100, currency: "USD" }, SBK: { price: 300, currency: "ZAR" }, PEP: { price: 150, currency: "USD" } };
  const market = (tickers: ReturnType<typeof createTestTicker>[], format?: "json") => createTestCliContext({
    config: createDefaultConfig("/unused-income"),
    store: { loadAllTickers: async () => tickers },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, ...prices[symbol]!, change: 0, changePercent: 0, previousClose: prices[symbol]!.price, lastUpdated: Date.now() }),
      getExchangeRate: async (currency) => (currency === "ZAR" ? 0.05 : 1),
    }),
  }, format ? { format } : {});
  setCliColorEnabledOverride(false);
  try {
    const cli = market([ko, sbk], "json");
    await showCollection("main", cli.context, { drip: { years: 1, withholding: 0 } });
    const exported = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }, cli.printed[0]!.options));
    // KO pays $2.00 on 100 shares; SBK R18.00 on 200 shares, $180 at 0.05.
    expect(exported.metadata.annualIncome).toBeCloseTo(200 + 180, 8);
    // Value: $10,000 + R60,000 ($3,000).
    expect(exported.metadata.portfolioYield).toBeCloseTo((380 / 13_000) * 100, 8);
    const sbkYear = exported.data.find((row: { symbol: string }) => row.symbol === "SBK");
    expect(sbkYear).toMatchObject({ dividendPerShare: 18, dividendCurrency: "ZAR", price: 300, grossIncome: 3600, netIncomeBase: 180 });
    expect(sbkYear.addedShares).toBeCloseTo(12, 10);

    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    try { await showCollection("main", market([ko, sbk, pep]).context); }
    finally { logger.mockRestore(); }
    const text = output.join("\n");
    expect(text).toMatch(/SBK[^\n]*\$180\.00 +6\.00%/);
    // PEP's history could not be read: its income and the total are unknown, never $0.
    expect(text).toMatch(/PEP[^\n]*— +— /);
    expect(text).toMatch(/TOTAL[^\n]*100\.0% +— +— /);
    expect(text).toContain("Income unavailable for PEP");
  } finally {
    spy.mockRestore();
    setCliColorEnabledOverride(null);
  }
});
