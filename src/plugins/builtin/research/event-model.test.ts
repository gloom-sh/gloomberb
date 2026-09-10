import { expect, test } from "bun:test";
import { buildEventRows, formatEventMetric } from "./event-model";

test("ADR reported EPS and company revenue keep their distinct currencies", () => {
  const rows = buildEventRows({ symbol: "TSM", currency: "USD", dividends: [], splits: [],
    earnings: [{ date: "2026-01-15", epsActual: 2.5 }],
  }, null, { financialCurrency: "TWD", quarterlyStatements: [
    { date: "2025-12-31", currency: "TWD", totalRevenue: 1000000000000, eps: 15 },
  ] }, "USD");
  expect(rows[0]).toMatchObject({ qEps: 2.5, qRevenue: 1000000000000, epsCurrency: "USD", revenueCurrency: "TWD" });
  expect(formatEventMetric(rows[0]?.qEps, rows[0]?.epsCurrency, "eps")).toBe("2.50 USD");
  expect(formatEventMetric(rows[0]?.qRevenue, rows[0]?.revenueCurrency, "revenue")).toBe("1T TWD");
});
