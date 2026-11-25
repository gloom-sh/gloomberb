import { expect, test } from "bun:test";
import { asPaidDividends, paidDividend, spinOffAdjustment, spinOffAdjustments } from "./spin-off-adjustments";

test("only a factor no share count states that lowers the price is a spin-off's adjustment", () => {
  expect(spinOffAdjustment({ date: "2026-10-01", fromFactor: 1000, toFactor: 6665 })).toEqual({ date: "2026-10-01", factor: 6.665 });
  // Splits in share terms, a reverse one of many shares, and a factor stated by its ratio alone are not.
  for (const split of [
    { date: "2024-04-22", fromFactor: 10, toFactor: 11 },
    { date: "2026-07-24", fromFactor: 150, toFactor: 1 },
    { date: "2025-11-17", fromFactor: 1, toFactor: 10 },
    { date: "2025-01-02", fromFactor: 1253, toFactor: 1000 },
    { date: "2025-01-02" },
  ]) expect(spinOffAdjustment(split)).toBeNull();
});

test("a dividend before spin-off adjustments is shown as paid, multiplied back by every one after its ex-date", () => {
  // GE's: 1281:1000 (2023-01-04) and 1253:1000 (2024-04-02), with its 1-for-8 reverse split a split.
  const splits = [
    { date: "2021-08-02", fromFactor: 8, toFactor: 1 },
    { date: "2023-01-04", fromFactor: 1000, toFactor: 1281 },
    { date: "2024-04-02", fromFactor: 1000, toFactor: 1253 },
  ];
  const adjustments = spinOffAdjustments(splits);
  expect(paidDividend({ exDate: "2022-12-14", amount: 0.049841 }, adjustments)).toEqual({ amount: 0.08, adjusted: 0.049841, divisor: 1.281 * 1.253 });
  expect(paidDividend({ exDate: "2023-12-27", amount: 0.063847 }, adjustments)).toMatchObject({ amount: 0.08, divisor: 1.253 });
  expect(paidDividend({ exDate: "2024-04-12", amount: 0.28 }, adjustments)).toEqual({ amount: 0.28 });
  // A figure no four-decimal amount rounds to keeps the history's decimals.
  expect(paidDividend({ exDate: "2023-12-27", amount: 0.123457 }, adjustments).amount).toBe(0.154692);
  // A sponsor's or the issuer's own published row is as paid already.
  const published = { exDate: "2023-12-27", amount: 0.08, source: { publisher: "iShares", url: "https://example.com" } };
  expect(paidDividend(published, adjustments)).toEqual({ amount: 0.08 });
  expect(asPaidDividends([published, { exDate: "2023-12-27", amount: 0.063847 }], splits).map((row) => row.amount)).toEqual([0.08, 0.08]);
});
