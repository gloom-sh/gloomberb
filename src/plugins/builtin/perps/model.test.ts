import { expect, test } from "bun:test";
import { historyCell, historyChange, historyColumns, historyRows, percent } from "./model";
import { perpHistory } from "./test-fixture";

test("paid funding normalizes each interval independently and stays separate from snapshots", () => {
  const time = "2026-10-03T01:00:00Z";
  const result = historyRows(perpHistory({ funding: [
    { marketId: "x", time, rate: 0.001, intervalHours: 8, premium: null, observedAt: time, sourceUrl: "https://example.com" },
    { marketId: "x", time: "2026-10-03T02:00:00Z", rate: 0.00025, intervalHours: 1, premium: null, observedAt: time, sourceUrl: "https://example.com" },
  ] }), "funding");
  expect(result.map((row) => row.value)).toEqual([0.001, 0.002]);
  expect(result[1]!.change).toBeCloseTo(0.001);
  expect(result[1]!.basis).toBe("Paid · 1h → 8h");
  expect(percent(result[1]!.value)).toBe("+0.200%");
});

test("a missing OI observation stays a chart gap and never creates a change", () => {
  const rows = [100, null, 200].map((openInterestUsd, index) => ({ time: `2026-10-03T0${index}:00:00Z`, resolution: "minute" as const,
    markPrice: 100, oraclePrice: 99, premium: null, fundingRate: null, fundingIntervalHours: null, openInterestBase: null, openInterestUsd,
    sampleCount: 1, firstObservedAt: "2026-10-03T00:00:00Z", lastObservedAt: "2026-10-03T00:00:00Z" }));
  expect(historyRows(perpHistory({ rows }), "oi").map((row) => row.change)).toEqual([null, null, null]);
});

test("history CSV names real units and exports unrounded values with percentage-point changes", () => {
  const row = { time: "2026-10-03T00:00:00Z", value: 0.000125, change: 0.00000123456, basis: "Paid · 1h → 8h" };
  expect(historyColumns("funding", "USDC").map((column) => column.label)).toEqual(["Time (UTC)", "Funding 8h %", "Change pp", "Observation basis"]);
  expect(historyCell(row, "value", "funding").value).toBe(0.0125);
  expect(historyCell(row, "change", "funding").value).toBeCloseTo(0.000123456);
  expect(historyCell(row, "change", "funding").text).toBe("+0.0001pp");
  expect(historyChange(null, "funding")).toBe("--");
  expect(historyColumns("oi", "USDC")[1]!.label).toBe("OI USD");
  expect(historyColumns("price", "USDC", false)[1]!.label).toBe("Mark USDC");
});
