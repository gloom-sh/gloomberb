import { expect, test } from "bun:test";
import { periodPnl } from "./period-pnl";

test("a book's P&L between two closes signs a short, sizes a future, and keeps the currency's move on its own line", () => {
  // The week of 26-30 Oct 2026: GDX short 200, two GC=F contracts of 100 oz, 1,000 2382.HK in HKD.
  const result = periodPnl([
    { symbol: "GDX", priceUnits: -200, currency: "USD", start: { day: "2026-10-23", price: 80.2 }, end: { day: "2026-10-30", price: 77.09 } },
    { symbol: "GC=F", priceUnits: 2 * 100, currency: "USD", start: { day: "2026-10-23", price: 4007.9 }, end: { day: "2026-10-30", price: 3898.9 } },
    { symbol: "2382", priceUnits: 1000, currency: "HKD", start: { day: "2026-10-23", price: 63.15 }, end: { day: "2026-10-30", price: 63.3 } },
    { symbol: "GONE", priceUnits: 10, currency: "USD", start: null, end: { day: "2026-10-30", price: 5 } },
  ], "USD", (currency, day) => currency === "HKD" ? (day === "2026-10-23" ? 1 / 7.8 : 1 / 7.75) : null);
  const row = (symbol: string) => result.rows.find((entry) => entry.symbol === symbol)!;
  expect(row("GDX").pnl).toBeCloseTo(622, 6);
  expect(row("GC=F").pnl).toBeCloseTo(-21_800, 6);
  // The price move at the end's rate; the currency's move on the start value is the FX line.
  expect(row("2382").pnl).toBeCloseTo(150 / 7.75, 6);
  expect(row("2382").fx).toBeCloseTo(63_150 * (1 / 7.75 - 1 / 7.8), 6);
  expect(result.fx).toBeCloseTo(row("2382").fx!, 9);
  expect(result.total).toBeCloseTo(622 - 21_800 + 63_300 / 7.75 - 63_150 / 7.8, 6);
  // A book that holds a short weighs on its gross exposure at the start, as its weights do; the unpriced holding is named, not counted.
  const gross = 200 * 80.2 + 200 * 4007.9 + 63_150 / 7.8;
  expect([result.contributionBasis, result.contributionBase]).toEqual(["gross", gross]);
  expect(row("GC=F").contribution).toBeCloseTo((-21_800 / gross) * 100, 9);
  expect(result.rows.reduce((sum, entry) => sum + (entry.contribution ?? 0), 0) + result.fxContribution!).toBeCloseTo(result.totalContribution!, 9);
  expect(result.unpriced).toEqual(["GONE"]);
});

test("a future in a lira book has no FX line on its contract value: the dollar moves its P&L alone", () => {
  // One ES contract (50 x the index) and 100 NTR shares, Mon 9 to Tue 10 Nov 2026, USD/TRY 50.1776 to 50.2294.
  const rate = (currency: string, day: string) => currency === "USD" ? (day === "2026-11-09" ? 50.1776 : 50.2294) : null;
  const result = periodPnl([
    { symbol: "ES=F", priceUnits: 50, currency: "USD", future: true, start: { day: "2026-11-09", price: 6800 }, end: { day: "2026-11-10", price: 6810 } },
    { symbol: "NTR", priceUnits: 100, currency: "USD", start: { day: "2026-11-09", price: 72.29 }, end: { day: "2026-11-10", price: 72.57 } },
  ], "TRY", rate);
  const row = (symbol: string) => result.rows.find((entry) => entry.symbol === symbol)!;
  expect(row("ES=F").pnl).toBeCloseTo(50 * 10 * 50.2294, 6);
  expect(row("ES=F").fx).toBe(0);
  expect(result.fx).toBeCloseTo(100 * 72.29 * (50.2294 - 50.1776), 6);
});
