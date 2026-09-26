import { describe, expect, test } from "bun:test";
import { fitTrend, sigmaVsTrend, trendAt, type TrendPoint } from "./trend";

function point(date: string, value: number): TrendPoint {
  return { date, value };
}

describe("fitTrend", () => {
  test("log model recovers a compounding growth rate", () => {
    const originMs = Date.parse("2000-01-01");
    const betaPerDay = 0.03 / 365.25;
    const points: TrendPoint[] = [];
    for (let year = 0; year <= 20; year += 1) {
      const date = `${2000 + year}-01-01`;
      const tDays = (Date.parse(date) - originMs) / 86_400_000;
      points.push(point(date, 80 * Math.exp(betaPerDay * tDays)));
    }
    const fit = fitTrend(points, "log");
    expect(fit.beta).toBeCloseTo(betaPerDay, 8);
    const outlierDate = points[10]!.date;
    const outlier = trendAt(fit, outlierDate) * Math.exp(2);
    expect(sigmaVsTrend({ ...fit, sigma: 0.05 }, outlier, outlierDate)).toBeCloseTo(40, 8);
  });

  test("linear model keeps the negative years a log fit would drop", () => {
    const points = [
      point("2000-01-01", -2),
      point("2001-01-01", 0),
      point("2002-01-01", 2),
      point("2003-01-01", 4),
    ];
    const linear = fitTrend(points, "linear");
    expect(linear.model).toBe("linear");
    // Leap years make the day spacing uneven, so the fit lands near, not on, the ends.
    expect(trendAt(linear, "2000-01-01")).toBeCloseTo(-2, 1);
    expect(trendAt(linear, "2003-01-01")).toBeCloseTo(4, 1);
    // The log fit sees only the two positive points, so its origin moves.
    expect(fitTrend(points, "log").originMs).toBe(Date.parse("2002-01-01"));
  });

  test("sigma is zero for a value the model cannot place", () => {
    const fit = fitTrend([point("2020-01-01", 1), point("2021-01-01", 2)], "log");
    expect(sigmaVsTrend(fit, -1, "2021-01-01")).toBe(0);
  });
});
