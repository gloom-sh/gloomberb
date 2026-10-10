import { expect, test } from "bun:test";
import type { TickerFinancials } from "../types/financials";
import { fundamentalsFreshness } from "./freshness";

const NOW = Date.parse("2026-10-09T13:30:00Z");

test("fundamentals are dated by their observation and name the period they run through", () => {
  const financials: TickerFinancials = {
    priceHistory: [],
    annualStatements: [{ date: "2025-12-31" }],
    quarterlyStatements: [{ date: "2026-03-31" }, { date: "2026-06-30" }],
    fundamentals: { fetchedAt: "2026-10-09T10:35:52.308Z", eps: -99.08 },
  };
  expect(fundamentalsFreshness(financials, NOW)).toMatchObject({
    asOf: "2026-10-09T10:35:52.308Z", status: "not-a-feed", basis: "reported through 2026-06-30",
  });
  // Old reported figures are not stale by age; the block's own flag makes them so.
  expect(fundamentalsFreshness({ ...financials, fundamentals: { ...financials.fundamentals, stale: true } }, NOW).status).toBe("stale");
  // Nothing dated: the line says when it was retrieved instead.
  expect(fundamentalsFreshness({ priceHistory: [], annualStatements: [], quarterlyStatements: [] }, NOW)).toMatchObject({
    asOf: null, basis: "reported data",
  });
});
