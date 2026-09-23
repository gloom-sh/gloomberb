import { expect, test } from "bun:test";
import { buildDividendMetrics, toDividendPayment } from "./client";
import { buildTrailingCashChartPoints } from "./view";

test("cash chart uses complete calendar-year cash totals without inventing historical price yields", () => {
  const payments = Array.from({ length: 25 }, (_, month) => toDividendPayment(
    new Date(Date.UTC(2024, 1 + month, 1)).toISOString().slice(0, 10), 0.5, "USD",
  )!);
  payments.push(toDividendPayment("2027-02-01", 50, "USD")!);
  const points = buildTrailingCashChartPoints(payments.reverse(), new Date("2026-02-01"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2025-02-01", 6], ["2026-02-01", 6],
  ]);
  expect(buildTrailingCashChartPoints(payments.slice(1, 3), new Date("2026-09-10"))).toEqual([]);
});

test("cash chart reaches the current zero cash rate after payments stop", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2023-08-04", 0.125, "USD")!,
    toDividendPayment("2024-08-07", 0.125, "USD")!,
  ], new Date("2026-09-10"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2024-08-04", 0], ["2024-08-07", 0.125], ["2025-08-07", 0], ["2026-09-10", 0],
  ]);
});

test("cash chart drops on each expiry and combines same-day cash and expiries once", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-01-01", 1, "USD")!,
    toDividendPayment("2023-01-01", 1, "USD")!,
    toDividendPayment("2023-04-01", 2, "USD")!,
    toDividendPayment("2024-01-01", 4, "USD")!,
    toDividendPayment("2024-01-01", 5, "USD")!,
  ], new Date("2024-05-01"));
  expect(points.map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2023-01-01", 1], ["2023-04-01", 3], ["2024-01-01", 11], ["2024-04-01", 9], ["2024-05-01", 9],
  ]);
});

test("February 29 cash leaves the clamped annual window on March 1 of the following year", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-01-01", 1, "USD")!,
    toDividendPayment("2024-02-28", 2, "USD")!,
    toDividendPayment("2024-02-29", 3, "USD")!,
  ], new Date("2025-03-02"));
  expect(points.slice(-3).map((point) => [point.date.toISOString().slice(0, 10), point.close])).toEqual([
    ["2025-02-28", 3], ["2025-03-01", 0], ["2025-03-02", 0],
  ]);
});

test("leap-day cash chart retains payments after the clamped February 28 cutoff", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-02-28", 1, "USD")!,
    toDividendPayment("2023-03-01", 4, "USD")!,
    toDividendPayment("2023-07-15", 1, "USD")!,
    toDividendPayment("2023-11-30", 1, "USD")!,
    toDividendPayment("2024-02-29", 1, "USD")!,
  ], new Date("2024-02-29T12:00:00Z"));
  expect(points.at(-1)?.close).toBe(7);
});

test("drifting ex-dates count one payment per period in trailing cash and its chart", () => {
  // SCHD's 2025-09-24 ex-date is a day earlier in the year than 2024-09-25; the 2026-09-28 fixture is four days later.
  const schd = [
    ["2024-06-26", 0.274667], ["2024-09-25", 0.251667], ["2024-12-11", 0.265], ["2025-03-26", 0.249],
    ["2025-06-25", 0.26], ["2025-09-24", 0.26], ["2025-12-10", 0.278], ["2026-03-25", 0.257], ["2026-06-24", 0.253],
    ["2026-09-28", 0.25],
  ].map(([date, amount]) => toDividendPayment(date as string, amount as number, "USD")!);
  const schdPoints = buildTrailingCashChartPoints(schd, new Date("2026-10-01T12:00:00Z"));
  expect(Math.max(...schdPoints.map((point) => point.close))).toBeLessThan(1.1);
  expect(Math.min(...schdPoints.map((point) => point.close))).toBeGreaterThan(1);
  expect(buildDividendMetrics(schd, null, 30, { now: new Date("2025-09-24T20:00:00Z") }).trailingRate).toBeCloseTo(1.034, 9);
  expect(buildDividendMetrics(schd, null, 30, { now: new Date("2026-09-26T20:00:00Z") }).trailingRate).toBeCloseTo(1.048, 9);

  // O's 2025-10-01 and 2025-10-31 ex-dates are both less than a year before 2026-09-30.
  const monthlyDates = ["2025-08-29", "2025-10-01", "2025-10-31", "2025-11-28", "2025-12-31", "2026-01-30", "2026-02-27",
    "2026-03-31", "2026-04-30", "2026-05-29", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
  const monthly = monthlyDates.map((date) => toDividendPayment(date, 0.25, "USD")!);
  expect(buildDividendMetrics(monthly, null, 50, { now: new Date("2026-09-30T20:00:00Z") }).trailingRate).toBeCloseTo(3, 9);
  expect(buildDividendMetrics(monthly, null, 50, { now: new Date("2026-09-29T20:00:00Z") }).trailingRate).toBeCloseTo(3, 9);
});
