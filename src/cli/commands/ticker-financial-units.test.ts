import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import { buildTickerReport } from "./ticker";

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
