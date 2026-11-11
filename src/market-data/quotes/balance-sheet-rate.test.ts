import { expect, test } from "bun:test";
import type { FinancialStatement, TickerFinancials } from "../../types/financials";
import { withBalanceSheetRate } from "./balance-sheet-rate";

// Pop Mart: CNY statements under an HKD cap whose source EV was withdrawn, so the bridge wants CNY/HKD on Jun 30, 2026.
const financials: TickerFinancials = {
  fundamentals: { enterpriseValue: undefined, unavailableFields: ["enterpriseValue"], marketCap: 195_000, marketCapCurrency: "HKD" },
  annualStatements: [],
  quarterlyStatements: [{ date: "2026-06-30", currency: "CNY", totalDebt: 0, cashAndCashEquivalents: 14_000 } as FinancialStatement],
  priceHistory: [],
};

test("a balance sheet in another currency reads both dollar legs' closes on its date, crossed and dated by the older", async () => {
  // USD/CNY and USD/HKD as sent: the yuan's last close before the Tuesday is the Monday's.
  const bars: Record<string, { date: string; close: number }[]> = {
    "CNY=X": [{ date: "2026-06-29", close: 7.15 }, { date: "2026-07-01", close: 7.2 }],
    "HKD=X": [{ date: "2026-06-29", close: 7.8 }, { date: "2026-06-30", close: 7.81 }],
  };
  const asked: string[] = [];
  const client = {
    getCloudHistory: async (symbol: string) => {
      asked.push(symbol);
      return { status: "success" as const, data: bars[symbol] ?? [] };
    },
  };
  const read = await withBalanceSheetRate(financials, client as never);
  expect(asked.sort()).toEqual(["CNY=X", "HKD=X"]);
  expect(read.balanceSheetRate).toEqual({ from: "CNY", to: "HKD", date: "2026-06-30", rate: (1 / 7.15) / (1 / 7.81), closeDate: "2026-06-29" });
  // A sheet in the cap's currency wants no close, and asks for none.
  const local = { ...financials, quarterlyStatements: [{ ...financials.quarterlyStatements[0]!, currency: "HKD" }] };
  expect(await withBalanceSheetRate(local, client as never)).toBe(local);
  expect(asked).toHaveLength(2);
});
