import { describe, expect, test } from "bun:test";
import {
  taiwanRevenueCode,
  taiwanUsReadthroughTicker,
} from "../../../api-client/taiwan-revenue";
import {
  buildMonthlyRevenueSeries,
  fmtSignedPct,
  fmtTwdB,
  stockMonthlyColumns,
  supplierBoardColumns,
} from "./taiwan-monthly-model";

describe("taiwan monthly revenue terminal model", () => {
  test("resolves Taiwan listings and US customer read-through tickers cleanly", () => {
    expect(taiwanRevenueCode("2330:TWSE")).toBe("2330");
    expect(taiwanRevenueCode("2330.TW")).toBe("2330");
    expect(taiwanRevenueCode("6488.TWO")).toBe("6488");
    expect(taiwanRevenueCode("AAPL")).toBeNull();
    expect(taiwanUsReadthroughTicker("NVDA")).toBe("NVDA");
    expect(taiwanUsReadthroughTicker("AAPL")).toBe("AAPL");
    expect(taiwanUsReadthroughTicker("2330:TWSE")).toBeNull();
  });

  test("formats TWD billions, signed percentages, and chart series", () => {
    expect(fmtTwdB(1250)).toBe("NT$1.25T");
    expect(fmtTwdB(367.47)).toBe("NT$367.5B");
    expect(fmtSignedPct(29.21)).toBe("+29.2%");
    expect(fmtSignedPct(-2.5, "pp")).toBe("-2.5pp");

    const series = buildMonthlyRevenueSeries(
      [
        { yearMonth: "2026-10", revenueTwdB: 367.47, yoyPct: 16.9 },
        { yearMonth: "2026-09", revenueTwdB: 330.98, yoyPct: 14.5 },
      ],
      { revenue: "accent", yoy: "positive" },
    );
    expect(series).toHaveLength(1);
    expect(series[0]!.points).toHaveLength(2);
    expect(stockMonthlyColumns(100).length).toBe(7);
    expect(supplierBoardColumns(100).length).toBe(7);
  });
});
