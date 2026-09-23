import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import { buildTickerReport, renderFundamentalsReport } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-ticker-units-unused");
const quote = { symbol: "UNITTEST", price: 100, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-09-11") };
async function report(financials: TickerFinancials): Promise<string> {
  return (await buildTickerReport({ symbol: "UNITTEST", tickerFile: null, financials, config, toBase: async value => value }))
    .replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
}

test("ticker monetary fundamentals keep reported units across foreign, minor and unknown currencies", async () => {
  for (const [currency, eps] of [["CNY", "CN¥2.50"], ["GBp", "2.50 GBp"], ["GBX", "2.50 GBX"], ["ILA", "2.50 ILA"], ["ZAc", "2.50 ZAc"], [" ", "2.50 (ccy?)"]] as const) {
    const financials: TickerFinancials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [],
      fundamentals: { eps: 2.5, revenue: 1_000_000, netIncome: 0, freeCashFlow: -25_000, financialCurrency: currency },
    };
    const text = await report(financials);
    expect(text).toContain(`EPS ${eps}`);
    expect(text).toContain(`Revenue 1M ${currency.trim() || "(ccy?)"}`);
    expect(text).toContain(`Net Income 0 ${currency.trim() || "(ccy?)"}`);
    expect(text).toContain(`Free Cash Flow -25k ${currency.trim() || "(ccy?)"}`);
    expect(financials.fundamentals?.eps).toBe(2.5);
  }
});

test("statement units use compatible history, keep explicit overrides and exclude share counts", async () => {
  const financials: TickerFinancials = { quote, priceHistory: [], financialCurrency: "CNY",
    annualStatements: [{ date: "2025-12-31", eps: 0, totalRevenue: 1_000_000, dilutedShares: 400_000 }], quarterlyStatements: [],
  };
  expect(await report(financials)).toContain("Diluted EPS CN¥0.00");
  financials.quarterlyStatements.push({ date: "2026-06-30", currency: "EUR", eps: -1.25, totalRevenue: 200_000 });
  const mixed = await report(financials);
  expect(mixed).toContain("Diluted EPS 0.00 (ccy?)");
  expect(mixed).toContain("Diluted EPS -€1.25");
  expect(mixed).toContain("Revenue 200k EUR");
  expect(mixed).toContain("Diluted Shares 400k");
  expect(mixed).not.toContain("Diluted Shares 400k CNY");
  financials.annualStatements[0]!.currency = "GBp";
  expect(await report(financials)).toContain("Diluted EPS 0.00 GBp");
  financials.annualStatements[0]!.eps = Number.NaN;
  expect(await report(financials)).not.toContain("NaN");
});

test("enterprise value is shown in the market cap's currency, converted or labelled", async () => {
  const financials: TickerFinancials = { quote: { ...quote, currency: "CHF", marketCap: 200e9 }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { marketCap: 200e9, marketCapCurrency: "CHF", enterpriseValue: 255e9 },
  };
  const render = async (toBase: (value: number, currency: string) => Promise<number>) => (
    await buildTickerReport({ symbol: "UNITTEST", tickerFile: null, financials, config, toBase })
  ).replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  const converted = await render(async (value, currency) => currency === "CHF" ? value * 1.2 : value);
  expect(converted).toContain("Market Cap 240B USD");
  expect(converted).toContain("Enterprise Value 306B USD");
  const unconverted = await render(async () => Number.NaN);
  expect(unconverted).toContain("Market Cap 200B CHF");
  expect(unconverted).toContain("Enterprise Value 255B CHF");
  // Local Yahoo fundamentals declare no capitalization unit: the listing's quote currency applies.
  const undeclared: TickerFinancials = { quote: { ...quote, marketCap: 3.8e12 }, annualStatements: [], quarterlyStatements: [], priceHistory: [],
    fundamentals: { enterpriseValue: 3.85e12 },
  };
  const plain = await report(undeclared);
  expect(plain).toContain("Market Cap 3.8T USD");
  expect(plain).toContain("Enterprise Value 3.85T USD");
  expect(renderFundamentalsReport({ ...undeclared, symbol: "UNITTEST" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " "))
    .toContain("Enterprise Value 3.85T USD");
});
