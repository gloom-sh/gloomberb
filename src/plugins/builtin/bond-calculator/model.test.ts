import { expect, test } from "bun:test";
import { bondDraftFromOptions, calculateBond, defaultBondDraft } from "./model";
import { parseBondBenchmark } from "./client";
import { bondCalculatorHeadless } from "./headless";
import type { HeadlessPaneContext } from "../../../types/plugin";

const draft = { ...defaultBondDraft(new Date("2026-09-22T00:00:00Z")), maturity: "2031-09-15" };

test("incomplete numeric drafts cannot silently become zero or exponential input", () => {
  for (const value of ["", " ", ".", "-", "1e3", "0x10", "1.2.3"]) {
    expect(() => calculateBond({ ...draft, coupon: value })).toThrow();
    expect(() => calculateBond({ ...draft, quote: value })).toThrow();
  }
  expect(calculateBond({ ...draft, coupon: "0", quote: "-.5" }).analytics.yieldPercent).toBe(-0.5);
  expect(() => bondDraftFromOptions({ price: 100, yield: 5 })).toThrow("not both");
  expect(() => bondDraftFromOptions({ endOfMonth: "false" })).toThrow("boolean");
});

test("price mode and shock scenarios preserve cash-flow terms and use dirty capital for return", () => {
  const fromYield = calculateBond(draft);
  const fromPrice = calculateBond({ ...draft, mode: "price", quote: String(fromYield.analytics.cleanPrice) });
  expect(fromPrice.analytics.yieldPercent).toBeCloseTo(4.25, 7);
  expect(fromPrice.analytics.accruedInterest).toBe(fromYield.analytics.accruedInterest);
  const shock = fromYield.sensitivity.at(-1)!;
  expect(shock.cleanPrice).toBeCloseTo(calculateBond({ ...draft, quote: "5.25" }).analytics.cleanPrice, 10);
  expect(shock.returnPercent).toBeCloseTo(shock.priceChange! / fromYield.analytics.dirtyPrice * 100, 10);
  expect(fromYield.sensitivity[3]!.priceChange).toBe(0);
});

test("benchmark parsing exposes malformed and older response points without disabling local math", () => {
  expect(() => parseBondBenchmark({ error: "Not found" })).toThrow();
  const curve = parseBondBenchmark([
    { maturityYears: 2, yield: 4.1, asOf: "2026-09-18" },
    { maturityYears: 5, yield: 4.2, asOf: "2026-09-18", stale: true },
    { maturityYears: 7, yield: 4.3 },
    { maturityYears: 10, yield: null, asOf: "2026-09-18", error: "Unavailable" },
    { maturityYears: 20, yield: "4.5", asOf: "2026-09-18" },
    null,
  ]);
  expect(curve.points).toHaveLength(4);
  expect(curve.notices).toHaveLength(4);
  expect(calculateBond(draft, curve.points).spread?.asOf).toBe("2026-09-18");
  expect(calculateBond({ ...draft, maturity: "2032-09-15" }, curve.points).spread).toBeNull();
});

test("headless calculations remain usable when optional cloud benchmark is absent", async () => {
  const report = await bondCalculatorHeadless.load({ rawArgument: "", argument: null, symbols: [], options: {
    settlement: draft.settlement, maturity: draft.maturity, coupon: draft.coupon, yield: draft.quote,
  } }, { apiClient: { getCloudYieldCurve: async () => { throw new Error("HTTP 404"); } } } as unknown as HeadlessPaneContext);
  expect(report.sections[0]!.entries?.find((entry) => entry.label === "Clean price")?.value).toBeCloseTo(103.333937, 6);
  expect(report.complete).toBe(false);
  expect(report.errors?.some((error) => error.includes("HTTP 404"))).toBe(true);
  expect(report.metadata?.treasuryAsOf).toBeNull();
  expect(report.metadata?.percentile).toBeNull();
  expect(report.sections[1]!.rows).toHaveLength(10);
});
