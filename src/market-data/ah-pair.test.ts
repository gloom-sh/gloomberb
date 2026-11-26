import { expect, test } from "bun:test";
import { ahListingKey, ahPairOf, ahPairSide, ahSpotFromUsdValues, compareAhPair, listingBoardLot, statesBoardLot } from "./ah-pair";
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
  // A ticker saved in HKEX's five digits (03750, on its venue's MIC or alias) is the same H share line.
  for (const [symbol, exchange, side] of [["3750", "HKEX", "h"], ["3750.HK", null, "h"], ["3750:HKEX", null, "h"],
    ["03750", "HKEX", "h"], ["03750", "XHKG", "h"], ["03750:HKEX", null, "h"], ["13750", "HKEX", null],
    ["300750", "SZSE", "a"], ["300750", "XSHE", "a"], ["300750.SZ", null, "a"], ["0700", "HKEX", null]] as const)
    expect(ahPairSide(pair, symbol, exchange)).toBe(side);
  expect(ahListingKey("700.HK")).toBe("0700:HKEX");
  expect(ahPairOf({ listings: [
    { symbol: "HSBA:LSE", exchange: "LSE", name: "HSBC HOLDINGS PLC", primary: true },
    { symbol: "0005:HKEX", exchange: "HKEX", name: "HSBC HOLDINGS", primary: false },
    { symbol: "HSBC", exchange: "NYSE", name: "HSBC HOLDINGS PLC", primary: false },
  ] })).toBeNull();
  expect(ahPairOf(null)).toBeNull();
});

test("a Hong Kong or Singapore line's board lot is read off its own listing, however the line is written", () => {
  // Zijin Mining's lines with the lot HKEX states for its H shares (500 since 13 Nov 2026), and DBS on SGX in 10s.
  const zijin = { listings: [
    { symbol: "601899:SSE", exchange: "SSE", name: "ZIJIN MINING", primary: true },
    { symbol: "2899:HKEX", exchange: "HKEX", name: "ZIJIN MINING", primary: false, boardLot: 500 },
  ] };
  for (const [symbol, exchange] of [["2899", "HKEX"], ["02899", "HKEX"], ["2899.HK", null], ["2899:HKEX", null]] as const) {
    expect(statesBoardLot(symbol, exchange)).toBe(true);
    expect(listingBoardLot(zijin, symbol, exchange)).toBe(500);
  }
  // The A share states none; neither does a line the company does not list, nor a lot that is not a whole number of shares.
  expect(listingBoardLot(zijin, "601899", "SSE")).toBeNull();
  expect(listingBoardLot(zijin, "0005", "HKEX")).toBeNull();
  expect(listingBoardLot({ listings: [{ ...zijin.listings[1]!, boardLot: 0 }] }, "2899", "HKEX")).toBeNull();
  expect(listingBoardLot({ listings: [{ symbol: "D05:SGX", exchange: "SGX", name: "DBS", primary: true, boardLot: 10 }] }, "D05", "SGX")).toBe(10);
  // Only the venues that state one are asked for it.
  for (const [symbol, exchange] of [["601899", "SSE"], ["HSBA", "LSE"], ["AAPL", null], [null, "HKEX"]] as const)
    expect(statesBoardLot(symbol, exchange)).toBe(false);
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
