import { expect, test } from "bun:test";
import { aggregateId, awardHistorySeries, money, rankedAggregates } from "./model";
import { awardHistory, awardsPayload } from "./test-fixture";

test("cumulative chart preserves currency, publisher scope and record type boundaries and missing values", () => {
  const points = awardsPayload().history;
  points.push(awardHistory({ month: "2025-04-01", cumulativeObligatedAmount: null }),
    awardHistory({ month: "2025-05-01", cumulativeObligatedAmount: "-3500000" }),
    awardHistory({ currency: "GBP", cumulativeObligatedAmount: "999999999" }),
    awardHistory({ source: "contracts-finder", cumulativeObligatedAmount: "888888888" }),
    awardHistory({ awardType: "modification", cumulativeObligatedAmount: "777777777" }));
  const series = awardHistorySeries(points, "usaspending", "USD", "prime", ["white", "yellow"]);
  expect(series[0]!.points.map((point) => point.value)).toEqual([5000000, 10000000, 15000000, null, -3500000]);
  expect(series.every((line) => line.unit === "USD")).toBe(true);
  expect(awardHistorySeries(points.slice(0, 2), "usaspending", "USD", "prime", ["white", "yellow"])).toEqual([]);
});

test("aggregate identity and rankings separate currencies and overlapping notice systems", () => {
  const row = awardsPayload().agencies[0]!;
  const overlap = { ...row, source: "contracts-finder", obligatedAmount: "999" };
  expect(aggregateId(row)).not.toBe(aggregateId(overlap));
  expect(aggregateId(row)).not.toBe(aggregateId({ ...row, currency: "GBP" }));
  expect(rankedAggregates([row, { ...row, currency: "GBP" }, overlap, { ...row, awardType: "subaward" }], "USD", "prime")).toHaveLength(2);
  expect(money(null)).toBe("--");
  expect(money("-85000000.05")).toBe("-85.00M");
});
