import { describe, expect, test } from "bun:test";
import type { CloudShortRate } from "../api-client/types";
import { forwardPointSize, impliedForward, parseForwardTenor, shortRateFor } from "./fx-forward";

function shortRate(currency: string, value: number | null, overrides: Partial<CloudShortRate> = {}): CloudShortRate {
  return {
    currency, name: `${currency} rate`, tenor: "overnight", tenorDays: 1, dayCountBasis: 360, publisher: "Publisher",
    sourceUrl: "https://example.com", value, asOf: value == null ? null : "2026-10-20", fetchedAt: null, stale: false,
    unavailableReason: value == null ? "the source answered 503" : null, ...overrides,
  };
}

describe("covered interest parity", () => {
  test("USD/MXN 30d carries spot by TIIE over SOFR, ACT/360 on both sides", () => {
    // TIIE 28d 6.776% and SOFR 3.87% on 18.35: 18.35 × (1 + 0.06776 × 30/360) / (1 + 0.0387 × 30/360).
    const forward = impliedForward(18.35, 30, { value: 3.87, dayCountBasis: 360 }, { value: 6.776, dayCountBasis: 360, currency: "MXN" });
    const expected = 18.35 * (1 + 0.06776 * 30 / 360) / (1 + 0.0387 * 30 / 360);
    expect(forward.forward).toBeCloseTo(expected, 12);
    expect(forward.forward).toBeCloseTo(18.39429, 4);
    expect(forward.pointSize).toBe(0.0001);
    expect(forward.points).toBeCloseTo((expected - 18.35) / 0.0001, 6);
    expect(forward.points).toBeCloseTo(442.95, 1);
    expect(forward.premiumPercent).toBeCloseTo((expected / 18.35 - 1) * 100, 10);
    // A year of it is close to the rate gap, as parity says.
    expect(forward.annualizedPercent).toBeCloseTo(2.8966, 3);
  });

  test("the higher-rate currency trades at a forward discount, and each side keeps its own day count", () => {
    // GBP/USD: SONIA is ACT/365, SOFR ACT/360. GBP yields more, so GBP/USD falls forward.
    const forward = impliedForward(1.3, 91, { value: 4.5, dayCountBasis: 365 }, { value: 3.87, dayCountBasis: 360, currency: "USD" });
    expect(forward.forward).toBeCloseTo(1.3 * (1 + 0.0387 * 91 / 360) / (1 + 0.045 * 91 / 365), 12);
    expect(forward.points).toBeLessThan(0);
    expect(forward.premiumPercent).toBeLessThan(0);
  });

  test("equal rates leave spot unchanged, and yen pairs count points of 0.01", () => {
    const flat = impliedForward(150, 30, { value: 4, dayCountBasis: 360 }, { value: 4, dayCountBasis: 360, currency: "JPY" });
    expect(flat.forward).toBe(150);
    expect(flat.points).toBe(0);
    expect(forwardPointSize("JPY")).toBe(0.01);
    expect(forwardPointSize("MXN")).toBe(0.0001);
  });
});

describe("forward tenors", () => {
  const today = new Date("2026-10-21T15:00:00Z");
  test("days and weeks count as typed; months and years run to the same day on the calendar", () => {
    expect(parseForwardTenor("30d", today)).toEqual({ label: "30d", days: 30 });
    expect(parseForwardTenor("2W", today)).toEqual({ label: "2w", days: 14 });
    expect(parseForwardTenor("1m", today)).toEqual({ label: "1m", days: 31 });
    expect(parseForwardTenor("3m", today)).toEqual({ label: "3m", days: 92 });
    expect(parseForwardTenor("1y", today)).toEqual({ label: "1y", days: 365 });
    // A month with no such day ends on its last.
    expect(parseForwardTenor("1m", new Date("2027-01-31T00:00:00Z"))).toEqual({ label: "1m", days: 28 });
  });

  test("a tenor that is not one, is zero or runs past a year says what to write", () => {
    expect(parseForwardTenor("30", today)).toMatchObject({ error: expect.stringContaining("such as 30d") });
    expect(parseForwardTenor("0d", today)).toEqual({ error: "A forward tenor is at least one day." });
    expect(parseForwardTenor("2y", today)).toMatchObject({ error: expect.stringContaining("Forwards run to 1y") });
  });
});

describe("short rates for a forward", () => {
  const rates = [shortRate("USD", 3.87, { name: "SOFR" }), shortRate("MXN", null, { name: "TIIE 28d" }), shortRate("EUR", 2.441)];
  test("a served rate is used; a currency with none or a rate not read is named", () => {
    expect(shortRateFor("USD", rates)).toMatchObject({ rate: { name: "SOFR", value: 3.87 } });
    expect(shortRateFor("MXN", rates)).toEqual({ error: "TIIE 28d (MXN) could not be read: the source answered 503." });
    expect(shortRateFor("ZAR", rates)).toEqual({ error: "No short rate for ZAR; forwards are implied for EUR, MXN, USD." });
  });
});
