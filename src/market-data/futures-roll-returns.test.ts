import { describe, expect, test } from "bun:test";
import type { PricePoint } from "../types/financials";
import { realizedVolatilityResult } from "./realized-volatility";
import { rollAdjustedHistory } from "./futures-roll-returns";

type Bar = [date: string, open: number | null, close: number, contract?: string];
const bars = (rows: readonly Bar[]): PricePoint[] => rows.map(([date, open, close, contract]) => ({
  date: new Date(`${date}T00:00:00Z`), close, ...(open != null ? { open } : {}), ...(contract ? { contract } : {}),
}));

// NG=F's daily bars as served, through the 26 Oct 2026 roll from NGX26 (2.64) to NGZ26 (3.022).
const NG_OCTOBER_ROLL = bars([
  ["2026-10-09", 3.168, 3.22, "NGX26"], ["2026-10-12", 3.17, 3.167, "NGX26"], ["2026-10-13", 3.176, 3.283, "NGX26"],
  ["2026-10-14", 3.321, 3.198, "NGX26"], ["2026-10-15", 3.274, 3.236, "NGX26"], ["2026-10-16", 3.212, 3.116, "NGX26"],
  ["2026-10-19", 3.09, 3.058, "NGX26"], ["2026-10-20", 3.043, 2.963, "NGX26"], ["2026-10-21", 3, 2.79, "NGX26"],
  ["2026-10-22", 2.78, 2.796, "NGX26"], ["2026-10-23", 2.787, 2.64, "NGX26"], ["2026-10-26", 3.006, 3.022, "NGZ26"],
  ["2026-10-27", 3.044, 3.004, "NGZ26"], ["2026-10-28", 3.071, 3.032, "NGZ26"], ["2026-10-29", 3.032, 2.952, "NGZ26"],
  ["2026-10-30", 2.904, 2.898, "NGZ26"], ["2026-11-02", 2.89, 2.856, "NGZ26"], ["2026-11-03", 2.86, 2.895, "NGZ26"],
  ["2026-11-04", 2.907, 2.959, "NGZ26"], ["2026-11-05", 2.951, 2.947, "NGZ26"], ["2026-11-06", 2.949, 2.998, "NGZ26"],
  ["2026-11-09", 3.032, 3.218, "NGZ26"], ["2026-11-10", 3.214, 3.296, "NGZ26"], ["2026-11-11", 3.239, 3.215, "NGZ26"],
]);

describe("rollAdjustedHistory", () => {
  test("reads NG=F's 20-day volatility across the 26 Oct roll within one contract, at about 48.7%", () => {
    expect(realizedVolatilityResult(NG_OCTOBER_ROLL, 20).value!).toBeCloseTo(0.697, 2);
    const { points, rolls, note } = rollAdjustedHistory(NG_OCTOBER_ROLL, "NG=F");
    const volatility = realizedVolatilityResult(points, 20).value!;
    expect(volatility).toBeGreaterThan(0.475);
    expect(volatility).toBeLessThan(0.495);
    expect(rolls).toEqual([{ date: "2026-10-26", from: "NGX26", to: "NGZ26", source: "bars", basis: "open" }]);
    expect(note).toBe("rolls back-adjusted");
    // The newest contract's prices are as traded; the ones before the roll are scaled, never the volumes.
    expect(points.at(-1)).toBe(NG_OCTOBER_ROLL.at(-1)!);
    expect(points.find((point) => point.date.toISOString().startsWith("2026-10-23"))!.close).toBeCloseTo(3.006, 6);
  });

  test("puts a roll the bars do not name where the contract calendar does: NG=F's Feb to Mar on 29 Jan 2026", () => {
    const january = bars([
      ["2026-01-22", 5.039, 5.045], ["2026-01-23", 4.872, 5.275], ["2026-01-26", 5.791, 6.8], ["2026-01-27", 6.646, 6.954],
      ["2026-01-28", 6.5, 7.46], ["2026-01-29", 3.742, 3.918], ["2026-01-30", 3.879, 4.354], ["2026-02-02", 3.708, 3.237],
    ]);
    const { points, rolls } = rollAdjustedHistory(january, "NG=F");
    expect(rolls).toEqual([{ date: "2026-01-29", from: "NGG26", to: "NGH26", source: "calendar", basis: "open" }]);
    // The -64% day is the March contract's own +4.6% from its open.
    expect(Math.log(points[5]!.close / points[4]!.close)).toBeCloseTo(Math.log(3.918 / 3.742), 9);
    // A stock, or a future's weekly bars, are left as served.
    expect(rollAdjustedHistory(january, "NG").note).toBeNull();
    expect(rollAdjustedHistory(january.filter((_, index) => index % 5 === 0), "NG=F").points).toEqual(january.filter((_, index) => index % 5 === 0));
  });
});
