import { describe, expect, test } from "bun:test";
import type { PricePoint, Quote } from "../../../types/financials";
import { FUTURES_CONTRACTS } from "./contracts";
import { frontContractCandidates, frontContractReturns, pickFrontContract } from "./returns";

const contract = (code: string) => FUTURES_CONTRACTS.find((entry) => entry.code === code)!;
const quote = (symbol: string, name: string, at = "2026-09-27T22:30:00Z"): Quote =>
  ({ symbol, name, price: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: Date.parse(at) });
const bars = (...rows: Array<[string, number]>): PricePoint[] =>
  rows.map(([day, close]) => ({ date: new Date(`${day}T04:00:00Z`), close }) as PricePoint);

describe("front contract", () => {
  test("is the month the quote names, in either of Yahoo's spellings", () => {
    expect(frontContractCandidates(contract("LE"), quote("LE=F", "Live Cattle Futures,Dec-2026"))).toEqual(["LEZ26.CME"]);
    expect(frontContractCandidates(contract("CL"), quote("CL=F", "Crude Oil Nov 26"))).toEqual(["CLX26.NYM"]);
  });

  test("a monthly root whose name has no month tries the months that can be front, across the year end", () => {
    expect(frontContractCandidates(contract("TTF"), quote("TTF=F", "Dutch TTF Natural Gas Calendar")))
      .toEqual(["TTFV26.NYM", "TTFX26.NYM", "TTFZ26.NYM"]);
    expect(frontContractCandidates(contract("BZ"), quote("BZ=F", "Brent Crude Oil", "2026-11-03T12:00:00Z")))
      .toEqual(["BZZ26.NYM", "BZF27.NYM", "BZG27.NYM"]);
    // A quarterly root without a month is not guessed.
    expect(frontContractCandidates(contract("ES"), quote("ES=F", "E-Mini S&P 500"))).toEqual([]);
  });

  test("among candidates, the price picks the contract whose last close it matches", () => {
    // Neighbouring TTF months settle a fraction of a percent apart.
    const picked = pickFrontContract([
      { symbol: "TTFV26.NYM", history: bars(["2026-09-25", 72.071]) },
      { symbol: "TTFX26.NYM", history: bars(["2026-09-25", 71.893]) },
      { symbol: "TTFZ26.NYM", history: [] },
    ], 72.07);
    expect(picked).toBe("TTFV26.NYM");
  });
});

describe("front contract returns", () => {
  const history = bars(
    ["2025-12-30", 80],
    ["2025-12-31", 80],
    ["2026-08-27", 95],
    ["2026-08-28", 96],
    ["2026-09-18", 98],
    ["2026-09-25", 100],
  );

  test("measure the live price against the contract's own earlier closes", () => {
    const returns = frontContractReturns(history, 102, Date.parse("2026-09-27T22:30:00Z"));
    // A week back from Sunday lands on Sunday the 20th: the Friday before it.
    expect(returns["1W"]).toBeCloseTo((102 / 98 - 1) * 100, 10);
    // A month back is Aug 27.
    expect(returns["1M"]).toBeCloseTo((102 / 95 - 1) * 100, 10);
    expect(returns.YTD).toBeCloseTo((102 / 80 - 1) * 100, 10);
  });

  test("without a live price the last close stands in", () => {
    expect(frontContractReturns(history, null, null)["1W"]).toBeCloseTo((100 / 98 - 1) * 100, 10);
  });

  test("a contract listed after the baseline date has no return for it", () => {
    const young = bars(["2026-09-01", 110], ["2026-09-18", 112], ["2026-09-25", 113]);
    const returns = frontContractReturns(young, 113, Date.parse("2026-09-27T22:30:00Z"));
    expect(returns["1W"]).not.toBeNull();
    expect(returns["1M"]).toBeNull();
    expect(returns.YTD).toBeNull();
  });

  test("dates that crossed a JSON bridge as strings still read", () => {
    const bridged = JSON.parse(JSON.stringify(history)) as PricePoint[];
    expect(frontContractReturns(bridged, 102, Date.parse("2026-09-27T22:30:00Z")).YTD).toBeCloseTo(27.5, 10);
  });
});
