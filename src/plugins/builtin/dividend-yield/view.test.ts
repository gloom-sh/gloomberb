import { expect, test } from "bun:test";
import { toDividendPayment } from "./client";
import { buildTrailingCashChartPoints } from "./view";

test("cash chart uses complete calendar-year cash totals without inventing historical price yields", () => {
  const payments = Array.from({ length: 25 }, (_, month) => toDividendPayment(
    new Date(Date.UTC(2024, 1 + month, 1)).toISOString().slice(0, 10), 0.5, "USD",
  )!);
  payments.push(toDividendPayment("2027-02-01", 50, "USD")!);
  const points = buildTrailingCashChartPoints(payments.reverse(), new Date("2026-02-01"));
  expect(points).toHaveLength(13);
  expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-01");
  expect(points.every((point) => point.close === 6)).toBe(true);
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
    toDividendPayment("2024-02-29", 1, "USD")!,
  ], new Date("2024-02-29T12:00:00Z"));
  expect(points.at(-1)?.close).toBe(5);
});
