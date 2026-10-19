import { expect, test } from "bun:test";
import { createTestTicker } from "../test-support/ticker";
import { futuresContractSize, previousFuturesSettlement, withFuturesContractSizes } from "./futures-positions";

test("a contract's size comes from its terms, a cents-quoted one at a hundred price units a dollar", () => {
  expect(futuresContractSize({ unit: "USD / troy oz", size: "100 troy oz", pointValue: 100 })).toEqual({ multiplier: 100, size: "100 oz" });
  // ZC quotes in cents a bushel: $50 a cent is 5,000 bushels.
  expect(futuresContractSize({ unit: "US cents / bushel", size: "5,000 bushels", pointValue: 50 })).toEqual({ multiplier: 5000, size: "5,000 bushels" });
  expect(futuresContractSize({ unit: "index points", size: "$50 x index", pointValue: 50 })).toEqual({ multiplier: 50, size: "$50 x index" });
  expect(futuresContractSize(null)).toBeNull();
  expect(futuresContractSize({ unit: "USD / troy oz", size: "100 troy oz", pointValue: 0 })).toBeNull();
});

test("the settlement before the latest is the session before it in daily bars, never another cadence's close", () => {
  const bar = (date: string, close: number, extra: { unsettled?: boolean; hours?: number } = {}) =>
    ({ date: new Date(Date.parse(`${date}T00:00:00Z`) + (extra.hours ?? 0) * 3_600_000), close, ...(extra.unsettled ? { unsettled: true } : {}) });
  const daily = [bar("2026-10-13", 4177.3), bar("2026-10-14", 4107.9), bar("2026-10-15", 4170.1), bar("2026-10-16", 4181.1)];
  expect(previousFuturesSettlement(daily, "2026-10-16", 4181.1)).toBe(4170.1);
  // A session that has closed but is not settled is no settlement to measure from.
  expect(previousFuturesSettlement([...daily.slice(0, 2), bar("2026-10-15", 4199, { unsettled: true }), daily[3]!], "2026-10-16", 4181.1)).toBe(4107.9);
  // A runtime east of UTC dates each bar at its own midnight, the evening before in UTC.
  expect(previousFuturesSettlement(daily.map((point) => ({ ...point, date: new Date(point.date.getTime() - 2 * 3_600_000) })), "2026-10-16", 4181.1)).toBe(4170.1);
  // Weekly bars (the week of the 12th closes at Friday's settle) and intraday bars are not sessions.
  expect(previousFuturesSettlement([bar("2026-10-05", 4216.3), bar("2026-10-12", 4181.1)], "2026-10-16", 4181.1)).toBeNull();
  expect(previousFuturesSettlement([bar("2026-10-15", 4170.1), bar("2026-10-16", 4175), bar("2026-10-16", 4181.1, { hours: 1 })], "2026-10-16", 4181.1)).toBeNull();
  // A close that is not the settlement, or no bar for its day, leaves the move unknown.
  expect(previousFuturesSettlement(daily, "2026-10-16", 4185)).toBeNull();
  expect(previousFuturesSettlement(daily.slice(0, 3), "2026-10-16", 4181.1)).toBeNull();
});

test("only futures lots without a size are sized, and an unchanged list keeps its records", () => {
  const equity = createTestTicker("SPY", "SPY", { positions: [{ portfolio: "main", shares: 10, avgCost: 1, broker: "manual" }] });
  const gold = createTestTicker("GC=F", "Gold", { assetCategory: "FUTURE", positions: [{ portfolio: "main", shares: -1, avgCost: 1, broker: "manual" }] });
  const terms = new Map([["GC=F", { size: { multiplier: 100, size: "100 oz" } }], ["SPY", { size: { multiplier: 100, size: "x" } }]]);
  const tickers = [equity, gold];
  const sized = withFuturesContractSizes(tickers, terms);
  expect(sized[0]).toBe(equity);
  expect(sized[1]!.metadata.positions[0]!.multiplier).toBe(100);
  expect(withFuturesContractSizes(sized, terms)).toBe(sized);
});
