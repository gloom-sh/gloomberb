import { expect, test } from "bun:test";
import { aggregateLoadedCongress } from "./aggregates";
import type { CloudCongressTradePayload } from "../../../api-client";
const trade = (id: string, overrides: Partial<CloudCongressTradePayload> = {}): CloudCongressTradePayload => ({ id, filingId: id, docId: id, chamber: "house", memberName: "Member", stateDistrict: "CA11", filingDate: "2026-08-01", transactionDate: "2026-07-01", notificationDate: null, lagDays: 31, side: "BUY", transactionType: "Purchase", ticker: "AAA", assetName: "A", assetType: "stock", owner: "self", rawOwner: "", amount: "$1,001-$15,000", amountLow: 1001, amountHigh: 15000, capGainsOver200: null, filingStatus: null, subholdingOf: null, description: null, sourceUrl: "", ...overrides });
test("loaded Congress totals deduplicate overlapping years and count distinct members", () => {
  const first = trade("one");
  const result = aggregateLoadedCongress([first, trade("two", { side: "SELL", memberName: "Second", stateDistrict: "TX01", filingDate: "2025-06-01", lagDays: null }), first]);
  expect(result.tickers[0]).toMatchObject({ tradeCount: 2, buyCount: 1, sellCount: 1, memberCount: 2, estimatedLow: 2002, estimatedHigh: 30000, lastFilingDate: "2026-08-01" });
  expect(result.members).toHaveLength(2);
  expect(result.members[0]?.avgLagDays).toBe(31);
  expect(result.members[1]?.avgLagDays).toBeNull();
});
test("unbounded and missing reported ranges remain unknown through aggregation", () => {
  const result = aggregateLoadedCongress([trade("one"), trade("two", { amountLow: null, amountHigh: null })]);
  expect(result.tickers[0]).toMatchObject({ estimatedLow: null, estimatedHigh: null });
  expect(result.members[0]).toMatchObject({ estimatedLow: null, estimatedHigh: null });
});
