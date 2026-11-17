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
/** Cash already in the portfolio's currency. */
const usd = (value: number) => [{ currency: "USD", amount: value, value }];

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
    cash: usd(36_000),
    targets: { VTI: 50, TLT: 10, ETF: 5, CASH: 30 },
  });

  expect(allocation).toMatchObject({ total: 100_000, weightBasis: "total", weightBase: 100_000 });
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

  const optionTrade = buildPortfolioAllocation({ holdings: [held("SPY 500C", 4_000, 2, 20)], cash: usd(6_000), targets: { "SPY 500C": 60 } });
  expect(optionTrade.rows[0]?.tradeUnits).toBe(1);
});

test("a book that holds a short weighs against its gross exposure, so a hedge netting near zero or below still has weights, and cash has none", () => {
  const longShort = buildPortfolioAllocation({ holdings: [held("LONG", 150, 1), held("SHORT", -50, -1)], cash: usd(0) });
  expect(longShort).toMatchObject({ total: 100, weightBasis: "gross", weightBase: 200 });
  expect(longShort.rows.map((row) => row.weight)).toEqual([75, -25]);

  // A miner's hedge: the short nets the long to $200, and the cash is no exposure.
  const hedge = buildPortfolioAllocation({
    holdings: [held("GDX", 420_000, 6_000), held("GC=F", -419_800, -1)],
    cash: usd(5_000),
    targets: { CASH: 10 },
  });
  expect(hedge).toMatchObject({ total: 5_200, weightBasis: "gross", weightBase: 839_800 });
  const [long, short] = hedge.rows.map((row) => row.weight!);
  expect(long).toBeCloseTo((420_000 / 839_800) * 100, 10);
  expect(short).toBeCloseTo((-419_800 / 839_800) * 100, 10);
  expect(Math.abs(long) + Math.abs(short)).toBeCloseTo(100, 10);
  expect(hedge.cash).toMatchObject({ value: 5_000, weight: null, targetWeight: 10, drift: null, tradeValue: null });

  // Net short: weights all the same, the short's -100% buying back to a target of none.
  const underwater = buildPortfolioAllocation({ holdings: [held("SHORT", -500, -5)], cash: usd(100), targets: { SHORT: 0 } });
  expect(underwater).toMatchObject({ total: -400, weightBasis: "gross", weightBase: 500 });
  expect(underwater.rows[0]).toMatchObject({ weight: -100, drift: -100, tradeValue: 500 });

  // A short without a price still makes the book a hedge; the gross is what is priced.
  const unpriced = buildPortfolioAllocation({ holdings: [held("LONG", 100, 1), held("SHORT", null, -5)], cash: usd(50) });
  expect(unpriced).toMatchObject({ weightBasis: "gross", weightBase: 100, unpriced: ["SHORT"] });

  expect(buildPortfolioAllocation({ holdings: [held("VTI", 100, 1)] }).cash).toBeNull();
});

test("cash in several currencies counts each balance once, and one without a rate is left out as an unpriced holding is", () => {
  // HK$390,000 at 7.80 and $1,200 beside $60,000 of shares: a book of $111,200.
  const book = buildPortfolioAllocation({
    holdings: [held("VTI", 60_000, 200)],
    cash: [{ currency: "USD", amount: 1_200, value: 1_200 }, { currency: "HKD", amount: 390_000, value: 50_000 }],
    targets: { VTI: 50, CASH: 50 },
  });
  expect(book).toMatchObject({ total: 111_200, weightBase: 111_200, unpricedCash: [] });
  // The CASH target is the whole line's: one weight, drift and trade for both balances, which add up to it.
  expect(book.cash).toMatchObject({ value: 51_200, targetWeight: 50 });
  expect(book.cash!.weight).toBeCloseTo((51_200 / 111_200) * 100, 10);
  expect(book.cash!.tradeValue).toBeCloseTo(55_600 - 51_200, 6);
  // Each currency weighs by its own value, largest first.
  expect(book.cash!.balances.map((balance) => [balance.currency, balance.amount, balance.value])).toEqual([["HKD", 390_000, 50_000], ["USD", 1_200, 1_200]]);
  const [hkd, usdLine] = book.cash!.balances.map((balance) => balance.weight!);
  expect(hkd! + usdLine!).toBeCloseTo(book.cash!.weight!, 10);
  expect(book.targetSum).toBe(100);

  // No TRY rate: the lira is left out of the total and the weights and named, never valued at zero or at 1:1.
  const lira = buildPortfolioAllocation({
    holdings: [held("VTI", 60_000, 200)],
    cash: [{ currency: "TRY", amount: 250_000, value: null }, { currency: "USD", amount: 1_200, value: 1_200 }],
    targets: { CASH: 10 },
  });
  expect(lira).toMatchObject({ total: 61_200, weightBase: 61_200, unpricedCash: ["TRY"] });
  expect(lira.rows[0]!.weight).toBeCloseTo((60_000 / 61_200) * 100, 10);
  // The cash line as a whole is unknown, so its weight and trade are too, and its target stays.
  expect(lira.cash).toMatchObject({ value: null, weight: null, targetWeight: 10, drift: null, tradeValue: null });
  expect(lira.cash!.balances.map((balance) => [balance.currency, balance.weight])).toEqual([["USD", (1_200 / 61_200) * 100], ["TRY", null]]);
  // A book whose only cash has no rate totals its holdings, as one with an unpriced holding does.
  expect(buildPortfolioAllocation({ holdings: [held("VTI", 100, 1)], cash: [{ currency: "TRY", amount: 5, value: null }] }))
    .toMatchObject({ total: 100, unpricedCash: ["TRY"], cash: { value: null } });
});

test("targets parse as percents and their sum names what is left unallocated", () => {
  expect(parseTargetWeight("12.5")).toBe(12.5);
  expect(parseTargetWeight(" 12.5% ")).toBe(12.5);
  // A decimal comma reads as one; a weight is never in the thousands, so 12,500 is 12.5 too.
  expect(parseTargetWeight("12,5%")).toBe(12.5);
  expect(parseTargetWeight("12,500")).toBe(12.5);
  expect(() => parseTargetWeight("101")).toThrow("between 0% and 100%");
  expect(() => parseTargetWeight("ten")).toThrow("percent");
  expect(describeTargetSum(100)).toBeNull();
  expect(describeTargetSum(null)).toBeNull();
  expect(describeTargetSum(92.5)).toBe("Targets add up to 92.5%; 7.5% is unallocated.");
  expect(describeTargetSum(110)).toBe("Targets add up to 110.0%, 10.0% over the whole portfolio.");
  // A hedged book's targets are shares of gross exposure, and what they leave is a short's share, not cash to place.
  expect(describeTargetSum(70, "gross")).toBe("Targets add up to 70.0% of gross exposure; 30.0% has no target.");
});

test("drift and trades round to their column's precision without a stray sign", () => {
  expect(formatAllocationDrift(2.345)).toBe("+2.3pp");
  expect(formatAllocationDrift(-0.04)).toBe("0.0pp");
  // Whole-share holdings trade in whole shares, fractional holdings to two decimals and coins to four,
  // trailing zeros dropped: a coin trade never prints eight decimals among whole shares.
  expect(formatTradeUnits(-364.88, { units: 1_500 })).toBe("-365");
  expect(formatTradeUnits(1_234.4, { units: 0 })).toBe("+1,234");
  expect(formatTradeUnits(-47.17956, { units: 383.7007 })).toBe("-47.18");
  expect(formatTradeUnits(-9.45963753, { units: 40, assetCategory: "CRYPTOCURRENCY" })).toBe("-9.4596");
  expect(formatTradeUnits(0.123456789, { units: 0, assetCategory: "CRYPTO" })).toBe("+0.1235");
  expect(formatTradeUnits(2.5, { units: 0.5, assetCategory: "CRYPTO" })).toBe("+2.5");
  expect(formatTradeUnits(0.2, { units: 10 })).toBe("0");
  expect(formatTradeUnits(0.00004, { units: 1, assetCategory: "CRYPTO" })).toBe("0");
});
