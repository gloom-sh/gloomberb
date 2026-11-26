import { expect, test } from "bun:test";
import type { TickerFinancials } from "../../types/financials";
import { hasEarlierGfRevenue } from "./history-link";

test("a revenue observation outside GF's period count cannot justify a link", async () => {
  const full: TickerFinancials = { annualStatements: Array.from({ length: 41 }, (_, index) => ({
    date: `${1985 + index}-12-31`, totalRevenue: index + 1,
  })), quarterlyStatements: [], priceHistory: [] };
  expect(await hasEarlierGfRevenue(async () => full, "annual", ["1986-12-31"])).toBe(false);
  expect(await hasEarlierGfRevenue(async () => full, "annual", ["1987-12-31"])).toBe(true);
});

test("a stalled or retryable extended read remains unknown, not an absence of older revenue", async () => {
  const partial: TickerFinancials = {
    annualStatements: [{ date: "2019-12-31", totalRevenue: 300 }], quarterlyStatements: [], priceHistory: [],
    statementHistory: { mode: "extended", source: "sec", status: "retryable-failure", fetchedAt: "2026-11-25" },
  };
  const dates = ["2023-12-31"];
  expect(await hasEarlierGfRevenue(async () => partial, "annual", dates)).toBeNull();
  expect(await hasEarlierGfRevenue(() => new Promise(() => {}), "annual", dates, 10)).toBeNull();
});
