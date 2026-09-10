import { expect, test } from "bun:test";
import { toDividendPayment } from "./client";
import { buildTrailingCashChartPoints } from "./view";

test("cash chart uses complete calendar-year cash totals without inventing historical price yields", () => {
  const payments = Array.from({ length: 25 }, (_, month) => toDividendPayment(
    new Date(Date.UTC(2024, 1 + month, 1)).toISOString().slice(0, 10), 0.5, "USD",
  )!);
  payments.push(toDividendPayment("2027-02-01", 50, "USD")!);
  const points = buildTrailingCashChartPoints(payments.reverse(), new Date("2026-09-10"));
  expect(points).toHaveLength(13);
  expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-01");
  expect(points.every((point) => point.close === 6)).toBe(true);
  expect(buildTrailingCashChartPoints(payments.slice(1, 3), new Date("2026-09-10"))).toEqual([]);
});

test("leap-day cash chart retains payments after the clamped February 28 cutoff", () => {
  const points = buildTrailingCashChartPoints([
    toDividendPayment("2022-02-28", 1, "USD")!,
    toDividendPayment("2023-03-01", 4, "USD")!,
    toDividendPayment("2024-02-29", 1, "USD")!,
  ], new Date("2024-02-29T12:00:00Z"));
  expect(points.at(-1)?.close).toBe(5);
});
