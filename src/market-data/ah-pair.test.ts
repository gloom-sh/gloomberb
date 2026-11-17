import { expect, test } from "bun:test";
import { ahListingKey, ahPairOf, ahPairSide, ahSpotFromUsdValues, compareAhPair } from "./ah-pair";
import type { PairPriceInput } from "./depositary-pair";

// CATL's lines as Gloom Cloud's company universe holds them, and HSBC's: London, Hong Kong and New York.
const catl = {
  listings: [
    { symbol: "300750:SZSE", exchange: "SZSE", name: "Contemporary Amperex Technology Co., Limited", primary: true },
    { symbol: "3750:HKEX", exchange: "HKEX", name: "CATL", primary: false },
  ],
};

test("an A+H company is one line in Hong Kong and one in Shanghai or Shenzhen", () => {
  const pair = ahPairOf(catl)!;
  expect(pair).toEqual({ h: "3750:HKEX", a: "300750:SZSE" });
  for (const [symbol, exchange, side] of [["3750", "HKEX", "h"], ["3750.HK", null, "h"], ["3750:HKEX", null, "h"],
    ["300750", "SZSE", "a"], ["300750.SZ", null, "a"], ["0700", "HKEX", null]] as const)
    expect(ahPairSide(pair, symbol, exchange)).toBe(side);
  expect(ahListingKey("700.HK")).toBe("0700:HKEX");
  expect(ahPairOf({ listings: [
    { symbol: "HSBA:LSE", exchange: "LSE", name: "HSBC HOLDINGS PLC", primary: true },
    { symbol: "0005:HKEX", exchange: "HKEX", name: "HSBC HOLDINGS", primary: false },
    { symbol: "HSBC", exchange: "NYSE", name: "HSBC HOLDINGS PLC", primary: false },
  ] })).toBeNull();
  expect(ahPairOf(null)).toBeNull();
});

test("the H price over the A price at the yuan's Hong Kong dollar rate, each price in its own currency", () => {
  // CATL at the close of 17 Nov 2026: H HK$366.80, A CN¥238.50, 1.1772 Hong Kong dollars a yuan.
  const at = Date.parse("2026-11-17T08:08:00Z");
  const h: PairPriceInput = { symbol: "3750:HKEX", price: 366.8, currency: "HKD", observedAt: at, open: false };
  const a: PairPriceInput = { symbol: "300750:SZSE", price: 238.5, currency: "CNY", observedAt: at - 60_000, open: false };
  const spot = ahSpotFromUsdValues({ rate: 0.1501, asOf: at }, { rate: 0.1501 / 1.1772, asOf: at + 1000 })!;
  expect(spot.rate).toBeCloseTo(1.1772, 6);
  expect(spot.observedAt).toBe(at);
  const comparison = compareAhPair(h, a, spot, at)!;
  expect(comparison.aInHkd).toBeCloseTo(280.76, 2);
  expect(comparison.premiumPercent).toBeCloseTo(30.65, 1);
  expect(comparison.timingNote).toBeNull();
  // Without a rate the prices still stand, with no premium; a price in another currency is no comparison.
  expect(compareAhPair(h, a, null, at)).toMatchObject({ aInHkd: null, premiumPercent: null });
  expect(compareAhPair({ ...h, currency: "USD" }, a, spot, at)).toBeNull();
  expect(ahSpotFromUsdValues({ rate: 0.15 }, null)).toBeNull();
});
