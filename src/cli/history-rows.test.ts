import { describe, expect, test } from "bun:test";
import { cleanFloat32Price, historyPriceDecimals, historyRows } from "./history-rows";

describe("history rows", () => {
  test("float32 provider noise becomes the intended decimal while real doubles stay exact", () => {
    expect(cleanFloat32Price(Math.fround(340.33))).toBe(340.33);
    expect(cleanFloat32Price(Math.fround(109556.16))).toBe(109556.16);
    expect(cleanFloat32Price(Math.fround(0.00000535))).toBe(0.00000535);
    // Not float32 values: a double source such as 750123.45 must not lose digits.
    expect(cleanFloat32Price(750123.45)).toBe(750123.45);
    expect(cleanFloat32Price(342.615)).toBe(342.615);
  });

  test("intraday bars keep their UTC time; daily bars stay trading dates", () => {
    const intraday = historyRows([
      { date: new Date("2026-09-22T13:30:00Z"), close: 1 },
      { date: new Date("2026-09-22T13:35:00Z"), close: 1 },
    ], "5m");
    expect(intraday.map((row) => row.date)).toEqual(["2026-09-22T13:30:00Z", "2026-09-22T13:35:00Z"]);
    expect(historyRows([{ date: new Date("2026-09-22T00:00:00Z"), close: 1 }], "1d")[0]!.date).toBe("2026-09-22");
    // Without a declared cadence, a clock time still marks the bar as intraday.
    expect(historyRows([{ date: new Date("2026-09-22T00:00:00Z"), close: 1 }, { date: new Date("2026-09-22T15:00:00Z"), close: 1 }], null)[1]!.date)
      .toBe("2026-09-22T15:00:00Z");
  });

  test("one decimal count per table that neither pads BTC nor zeroes sub-cent coins", () => {
    const rows = (closes: number[]) => historyRows(closes.map((close, index) => ({ date: new Date(Date.UTC(2026, 0, index + 1)), close })), "1d");
    expect(historyPriceDecimals(rows([81142.609375, 80867.0859375]))).toBe(2);
    expect(historyPriceDecimals(rows([340.33, 341.163, 342.615]))).toBe(3);
    expect(historyPriceDecimals(rows([1.147934, 1.14]))).toBe(6);
    expect(historyPriceDecimals(rows([0.00000535, 0.0000054]))).toBe(8);
  });
});
