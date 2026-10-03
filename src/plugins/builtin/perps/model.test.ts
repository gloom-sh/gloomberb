import { expect, test } from "bun:test";
import { boardColumns, boardRows, historyRows, percent } from "./model";
import { perpBoard, perpHistory, perpRow } from "./test-fixture";

test("market search keeps dex identity and missing numbers sort last in both directions", () => {
  const unknown = perpRow({ marketId: "other:default:BTC", openInterestUsd: null });
  for (const direction of ["asc", "desc"] as const) {
    expect(boardRows([unknown, ...perpBoard().rows], "crypto", "", { column: "openInterestUsd", direction }).at(-1)).toEqual(unknown);
  }
  const stock = perpBoard().rows.find((row) => row.assetClass === "stocks")!;
  expect(boardRows(perpBoard().rows, "stocks", stock.marketId, { column: "openInterestUsd", direction: "desc" })).toEqual([stock]);
  expect(boardRows([perpRow({ delisted: true })], "all", "", { column: "market", direction: "asc" })).toEqual([]);
});

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

test("narrow boards preserve dislocation and exposure while raw funding never loses its interval", () => {
  for (const width of [80, 90, 110, 128, 160, 200]) for (const compare of [false, true]) {
    const ids = boardColumns(width, compare).map((column) => column.id);
    for (const id of ["market", "markPrice", "fundingRate8h", "openInterestUsd", "premium"]) expect(ids).toContain(id);
    expect(ids.includes("fundingRate")).toBe(ids.includes("interval"));
    if (compare) expect(ids).toContain("venue");
  }
});
