import { expect, test } from "bun:test";
import { appendTickerHoldings, type TickerHoldings, type TickerHolderRow } from "./signals";
const row = (id: string, value: number | null, action: TickerHolderRow["action"] = "held"): TickerHolderRow => ({ id, cik: id, fund: id, ticker: "AAA", cusip: "one", issuer: "A", type: "SH", value, shares: 1, weight: null, previousWeight: null, weightChange: null, action });
const page = (rows: TickerHolderRow[], overrides: Partial<TickerHoldings> = {}): TickerHoldings => ({ ticker: "AAA", quarter: "2026Q2", period: "2026-06-30", previousPeriod: "2026-03-31", rows, warnings: [], asOf: "", holderCount: 10, newCount: 2, exitCount: 1, totalValue: 0, valueScope: "page", hasMore: true, nextOffset: 25, ...overrides });
test("appending overlapping holder pages does not double count values and exits do not poison the total", () => {
  const result = appendTickerHoldings(page([row("1", 20), row("2", 30)]), page([row("2", 30), row("3", null, "exit")], { warnings: ["partial"], nextOffset: 50 }));
  expect(result.rows).toHaveLength(3);
  expect(result.totalValue).toBe(50);
  expect(result.nextOffset).toBe(50);
  expect(result.warnings).toEqual(["partial"]);
  expect(appendTickerHoldings(result, page([row("4", null)])).totalValue).toBeNull();
});
test("a quarter rollover replaces prior pages", () => {
  const next = page([row("1", 40)], { period: "2026-09-30" });
  expect(appendTickerHoldings(page([row("2", 30)]), next)).toBe(next);
});
