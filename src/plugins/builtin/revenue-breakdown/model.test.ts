import { describe, expect, test } from "bun:test";
import type { RevenueBreakdownPayload } from "../../../api-client/revenue-breakdown";
import { barLevels, reportedSpan, revenueAmount, sortRevenueRows } from "./model";

const row = (label: string, values: (number | null)[], yoy: number | null = null) => ({
  key: `p:${label}`, label, values, ttm: null, yoy, share: null,
});

describe("revenue breakdown model", () => {
  test("Trend scales a row to its own range; Actual shares one scale", () => {
    const values = [40, null, 80, 60];
    const rounded = (levels: (number | null)[]) => levels.map((level) => (level === null ? null : Math.round(level * 100) / 100));
    expect(rounded(barLevels(values, "trend", 200))).toEqual([0.14, null, 1, 0.57]);
    expect(barLevels(values, "actual", 200)).toEqual([0.2, null, 0.4, 0.3]);
    // A flat line still draws, and a tiny row stays visible on the shared scale.
    expect(barLevels([5, 5], "trend", 200)).toEqual([0.6, 0.6]);
    expect(barLevels([1], "actual", 1000)).toEqual([0.06]);
  });

  test("amounts keep three significant figures", () => {
    expect([54_252e6, 245_500e6, 7_883e6, 31e9, 380e6, 1.2e12, null].map(revenueAmount))
      .toEqual(["54.3B", "246B", "7.88B", "31.0B", "380M", "1.20T", "--"]);
  });

  test("sorting puts unreported values last in both directions", () => {
    const rows = [row("a", [1], null), row("b", [2], 0.1), row("c", [3], -0.2)];
    expect(sortRevenueRows(rows, { column: "yoy", direction: "desc" }).map((r) => r.label)).toEqual(["b", "c", "a"]);
    expect(sortRevenueRows(rows, { column: "yoy", direction: "asc" }).map((r) => r.label)).toEqual(["c", "b", "a"]);
  });

  test("leading quarters nobody reported are dropped", () => {
    const payload = {
      periods: [1, 2, 3].map((quarter) => ({ end: `2026-0${quarter * 3}-30`, fiscalYear: 2026, fiscalQuarter: quarter })),
      total: [null, 10, 12],
      rows: [row("a", [null, 4, 5])],
    } as unknown as RevenueBreakdownPayload;
    const span = reportedSpan(payload);
    expect(span.periods.map((period) => period.fiscalQuarter)).toEqual([2, 3]);
    expect(span.rows[0]!.values).toEqual([4, 5]);
  });
});
