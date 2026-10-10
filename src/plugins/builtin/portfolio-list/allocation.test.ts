import { expect, test } from "bun:test";
import {
  buildPortfolioAllocation,
  describeTargetSum,
  formatAllocationDrift,
  formatTradeUnits,
  parseTargetWeight,
  type AllocationHolding,
} from "./allocation";

const held = (symbol: string, marketValue: number | null, units: number, unitPrice: number | null = null): AllocationHolding => (
  { symbol, held: true, marketValue, units, unitPrice }
);

test("weights include cash, leave unpriced holdings out, and trades reach the target at the position's own unit value", () => {
  const allocation = buildPortfolioAllocation({
    holdings: [
      held("VTI", 60_000, 200),
      // An option: 2 contracts worth 4,000 at a 100 multiplier trade 2,000 per contract, not at the quote.
      held("SPY 500C", 4_000, 2, 20),
      held("ETF", null, 100),
      { symbol: "TLT", held: false, marketValue: 0, units: 0, unitPrice: 90 },
      { symbol: "NEW", held: false, marketValue: 0, units: 0, unitPrice: 10 },
    ],
    cashValue: 36_000,
    targets: { VTI: 50, TLT: 10, ETF: 5, CASH: 30 },
  });

  expect(allocation.total).toBe(100_000);
  expect(allocation.unpriced).toEqual(["ETF"]);
  expect(allocation.targetSum).toBe(95);
  const [vti, option, unpriced, tlt, untargeted] = allocation.rows;
  expect(vti).toMatchObject({ weight: 60, targetWeight: 50, drift: 10, tradeValue: -10_000, tradeUnits: -33.333333333333336 });
  expect(option).toMatchObject({ weight: 4, drift: null, tradeValue: null, tradeUnits: null });
  // Unpriced: no weight, drift or trade, rather than a weight of zero.
  expect(unpriced).toMatchObject({ weight: null, targetWeight: 5, drift: null, tradeValue: null });
  // Listed but not held: weighs zero against its target and buys at the quote.
  expect(tlt).toMatchObject({ weight: 0, drift: -10, tradeValue: 10_000, tradeUnits: 10_000 / 90 });
  expect(untargeted?.weight).toBeNull();
  expect(allocation.cash).toMatchObject({ value: 36_000, weight: 36, targetWeight: 30, tradeValue: -6_000, tradeUnits: null });

  const optionTrade = buildPortfolioAllocation({ holdings: [held("SPY 500C", 4_000, 2, 20)], cashValue: 6_000, targets: { "SPY 500C": 60 } });
  expect(optionTrade.rows[0]?.tradeUnits).toBe(1);
});

test("a short weighs against the net total, and a total that is not positive has no weights", () => {
  const longShort = buildPortfolioAllocation({ holdings: [held("LONG", 150, 1), held("SHORT", -50, -1)], cashValue: 0 });
  expect(longShort.total).toBe(100);
  expect(longShort.rows.map((row) => row.weight)).toEqual([150, -50]);

  const underwater = buildPortfolioAllocation({ holdings: [held("SHORT", -500, -5)], cashValue: 100, targets: { SHORT: 0 } });
  expect(underwater.total).toBe(-400);
  expect(underwater.rows[0]).toMatchObject({ weight: null, drift: null, tradeValue: null });

  // Cash in a currency without a rate leaves the total unknown, not smaller.
  expect(buildPortfolioAllocation({ holdings: [held("VTI", 100, 1)], cashValue: Number.NaN }).total).toBeNull();
  expect(buildPortfolioAllocation({ holdings: [held("VTI", 100, 1)] }).cash).toBeNull();
});

test("targets parse as percents and their sum names what is left unallocated", () => {
  expect(parseTargetWeight("12.5")).toBe(12.5);
  expect(parseTargetWeight(" 12.5% ")).toBe(12.5);
  expect(() => parseTargetWeight("101")).toThrow("between 0% and 100%");
  expect(() => parseTargetWeight("ten")).toThrow("percent");
  expect(describeTargetSum(100)).toBeNull();
  expect(describeTargetSum(null)).toBeNull();
  expect(describeTargetSum(92.5)).toBe("Targets add up to 92.5%; 7.5% is unallocated.");
  expect(describeTargetSum(110)).toBe("Targets add up to 110.0%, 10.0% over the whole portfolio.");
});

test("drift and trades round to their column's precision without a stray sign", () => {
  expect(formatAllocationDrift(2.345)).toBe("+2.3pp");
  expect(formatAllocationDrift(-0.04)).toBe("0.0pp");
  // Whole-share holdings trade in whole shares; fractional holdings and coins keep their decimals.
  expect(formatTradeUnits(-364.88, { units: 1_500 })).toBe("-365");
  expect(formatTradeUnits(1_234.4, { units: 0 })).toBe("+1,234");
  expect(formatTradeUnits(-47.17956, { units: 383.7007 })).toBe("-47.1796");
  expect(formatTradeUnits(0.123456789, { units: 0, assetCategory: "CRYPTO" })).toBe("+0.12345679");
  expect(formatTradeUnits(0.2, { units: 10 })).toBe("0");
});
