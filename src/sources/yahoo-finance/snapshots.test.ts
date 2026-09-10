import { expect, test } from "bun:test";
import { buildYahooStatements } from "./financials";
import { loadYahooTickerFinancials } from "./snapshots";

test("Yahoo preserves report currency and calculates operating margin from operating income", async () => {
  const metrics = { annualTotalRevenue: 1000, annualOperatingIncome: 200, annualEBITDA: 300, annualNetIncome: 150 };
  const financials = await loadYahooTickerFinancials("TSM", {
    providerId: "yahoo",
    fetchAssetProfile: async () => undefined,
    fetchChart: async () => ({ meta: { currency: "USD", regularMarketPrice: 200 }, history: [{ date: new Date("2025-12-31"), close: 200 }] }),
    fetchExtendedHoursData: async () => ({}),
    fetchQuoteSupplement: async () => ({}),
    fetchTimeseries: async () => Object.entries(metrics).map(([key, value]) => ({
      meta: { type: [key] },
      [key]: [{ asOfDate: "2025-12-31", currencyCode: "TWD", reportedValue: { raw: value } }],
    })),
  });
  expect(financials.quote?.currency).toBe("USD");
  expect(financials.financialCurrency).toBe("TWD");
  expect(financials.annualStatements[0]?.currency).toBe("TWD");
  expect(financials.fundamentals).toMatchObject({ financialCurrency: "TWD", revenue: 1000, operatingMargin: 0.2 });
});


test("Yahoo never overwrites statement currency while adding another metric", () => {
  expect(buildYahooStatements({
    annualTotalRevenue: [{ asOfDate: "2025-12-31", value: 3000, currency: "TWD" }],
    annualNetIncome: [{ asOfDate: "2025-12-31", value: 50, currency: "USD" }],
  }, "annual")).toEqual([{ date: "2025-12-31", totalRevenue: 3000, currency: "TWD" }]);
});
